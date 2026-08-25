import type {Abi} from 'abitype';
import type {EIP1193DATA, EIP1193ProviderWithoutEvents} from 'eip-1193';
import {logs} from 'named-logs';
import type {LogEvent, UsedStreamConfig} from '../../types.js';
import type {UnlessCancelledFunction} from '../utils/promises.js';
import {
	getBlockData,
	getBlockDataFromMultipleHashes,
	getTransactionData,
	getTransactionDataFromMultipleHashes,
	type LogTransactionData,
} from './ethereum.js';

const namedLogger = logs('@etherfold/core');

/**
 * Block timestamps already paid for, keyed by block HASH and bounded by height.
 *
 * Keyed by hash because a reorg puts two different blocks at one height, and
 * bounded by height because `getFromBlock` never re-scans below
 * `latestBlock - finality`, so nothing under that window can be asked for
 * again. Owned by the CALLER rather than by this module: it is a per-fetcher
 * cache of chain data, and a module-level one would be shared by two indexers
 * that have nothing to do with each other.
 */
export type BlockTimestampCache = Map<string, {number: number; timestamp: number}>;

export type BlockFetcher = (
	blockHashes: string[],
	unlessCancelled: UnlessCancelledFunction,
) => Promise<{timestamp: number}[]>;

export type TransactionFetcher = (
	transactionHashes: string[],
	unlessCancelled: UnlessCancelledFunction,
) => Promise<LogTransactionData[]>;

/** Fetch block data one call at a time, or in one `eth_batch` if the provider has it. */
export function blockFetcherFor(
	provider: EIP1193ProviderWithoutEvents,
	providerSupportsETHBatch?: boolean,
): BlockFetcher {
	return async (blockHashes, unlessCancelled) => {
		if (providerSupportsETHBatch) {
			return getBlockDataFromMultipleHashes(provider, blockHashes);
		}
		const result = [];
		for (const blockHash of blockHashes) {
			namedLogger.info(`getting block ${blockHash}...`);
			result.push(await unlessCancelled(getBlockData(provider, blockHash as EIP1193DATA)));
		}
		return result;
	};
}

/** Fetch transaction data one call at a time, or in one `eth_batch` if the provider has it. */
export function transactionFetcherFor(
	provider: EIP1193ProviderWithoutEvents,
	providerSupportsETHBatch?: boolean,
): TransactionFetcher {
	return async (transactionHashes, unlessCancelled) => {
		if (providerSupportsETHBatch) {
			return getTransactionDataFromMultipleHashes(provider, transactionHashes);
		}
		const result = [];
		for (const transactionHash of transactionHashes) {
			namedLogger.info(`getting transaction ${transactionHash}...`);
			result.push(await unlessCancelled(getTransactionData(provider, transactionHash as EIP1193DATA)));
		}
		return result;
	};
}

/**
 * Fill in the parts of an event the log itself does not carry: the block
 * timestamp and the transaction that emitted it.
 *
 * ## Why it is here and not in `EthereumIndexer`
 *
 * `alwaysFetchTimestamps` and `alwaysFetchTransactions` live in the STREAM
 * CONFIG, which is hashed into the wire identity, so the two deployment shapes
 * of ADR-0003 must honour them identically: the single-process `EthereumIndexer`
 * and the split `LogFetcher` both push events at a processor that was promised
 * those fields. The receiving half makes no chain calls at all, so the fetcher
 * is the ONLY side that can pay for them, and a second implementation of this
 * would be a second set of round-trips to get subtly wrong (which block a
 * timestamp belongs to when two hashes share a height, which log wins when the
 * node already put one on).
 *
 * It MUTATES the events in place, as the engine always did: they were just
 * decoded from a response nobody else holds a reference to, and copying a
 * fetched range to add two fields would double the peak memory of the largest
 * thing this library holds.
 */
export async function enrichEvents<ABI extends Abi>(
	events: LogEvent<ABI>[],
	options: {
		streamConfig: UsedStreamConfig;
		/** The chain tip, used to bound the timestamp cache by the reorg window. */
		latestBlock: number;
		cache: BlockTimestampCache;
		getBlocks: BlockFetcher;
		getTransactions: TransactionFetcher;
	},
	unlessCancelled: UnlessCancelledFunction,
): Promise<void> {
	const {streamConfig, latestBlock, cache} = options;
	const blockTimestamps: {[hash: string]: number} = {};
	const transactions: {[hash: string]: LogTransactionData} = {};
	let anyTransactionFetched = false;
	let anyTimestampResolved = false;

	// needed to prune the timestamp cache, which is keyed by hash but bounded by height
	const blockNumberPerHash = new Map<string, number>();
	const blockHashes: string[] = [];
	const transactionHashes: string[] = [];
	// We deduplicate by hash (not by block number / position) so that every distinct
	// block or transaction gets fetched exactly once, even when two different block
	// hashes share the same block number (e.g. after a reorg within the unconfirmed
	// window, or when logs from multiple filters are merged out of strict order).
	const seenBlockHashes = new Set<string>();
	const seenTransactionHashes = new Set<string>();
	for (const event of events) {
		if (streamConfig.alwaysFetchTransactions) {
			if (!seenTransactionHashes.has(event.transactionHash)) {
				seenTransactionHashes.add(event.transactionHash);
				transactionHashes.push(event.transactionHash);
			}
		}

		// The log itself carries `blockTimestamp` on any node implementing
		// execution-apis#639 (geth >= 1.16.0, reth, besu, erigon, anvil), so only
		// the blocks whose logs did NOT carry one cost a round-trip. Hardhat's EDR
		// does not emit it as of 3.14.0, which is why the fallback still exists;
		// ADR-0002 makes that saving matter, since the in-browser path is primary
		// and cannot even batch these calls.
		if (streamConfig.alwaysFetchTimestamps && event.blockTimestamp === undefined) {
			blockNumberPerHash.set(event.blockHash, event.blockNumber);
			const cached = cache.get(event.blockHash);
			if (cached) {
				// already paid for on an earlier round: the re-scan window overlaps
				blockTimestamps[event.blockHash] = cached.timestamp;
				anyTimestampResolved = true;
			} else if (!seenBlockHashes.has(event.blockHash)) {
				seenBlockHashes.add(event.blockHash);
				blockHashes.push(event.blockHash);
			}
		}
	}

	if (blockHashes.length > 0) {
		namedLogger.info(`fetching a batch of  ${blockHashes.length} blocks (no blockTimestamp on their logs)...`);
		const blocks = await options.getBlocks(blockHashes, unlessCancelled);

		namedLogger.info(`...got  ${blocks.length} blocks back`);

		for (let i = 0; i < blockHashes.length; i++) {
			const hash = blockHashes[i];
			const timestamp = blocks[i].timestamp;
			blockTimestamps[hash] = timestamp;
			const number = blockNumberPerHash.get(hash);
			if (number !== undefined) {
				cache.set(hash, {number, timestamp});
			}
		}
		anyTimestampResolved = true;
	}

	// Bounded by the reorg window, not by the length of the chain. `getFromBlock`
	// never re-scans below `latestBlock - finality`, so an entry below it can
	// never be needed again. This is also what evicts reorged-out hashes, which
	// nothing else would ever ask for.
	for (const [hash, block] of cache) {
		if (latestBlock - block.number > streamConfig.finality) {
			cache.delete(hash);
		}
	}

	if (transactionHashes.length > 0) {
		namedLogger.info(`fetching a batch of ${transactionHashes.length} transactions...`);
		const transactionReceipts = await options.getTransactions(transactionHashes, unlessCancelled);

		namedLogger.info(`...got ${transactionReceipts.length} transactions back`);

		for (let i = 0; i < transactionHashes.length; i++) {
			transactions[transactionHashes[i]] = transactionReceipts[i];
		}
		anyTransactionFetched = true;
	}

	if (anyTransactionFetched || anyTimestampResolved) {
		for (const event of events) {
			if (streamConfig.alwaysFetchTransactions) {
				event.transaction = transactions[event.transactionHash];
			}
			// a timestamp the node already put on the log always wins: it needed no
			// fetch and it came from the same response as the log itself
			if (event.blockTimestamp === undefined) {
				event.blockTimestamp = blockTimestamps[event.blockHash];
			}
		}
	}
}
