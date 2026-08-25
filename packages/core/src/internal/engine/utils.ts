import type {Abi} from 'abitype';
import {logs} from 'named-logs';
import {UnexpectedFromBlockError} from '../../errors.js';
import type {AllContractData, ContextIdentifier, EventBlock, IndexingSource, LastSync, LogEvent} from '../../types.js';

const namedLogger = logs('@etherfold/core');

/**
 * How a reorg was concluded.
 *
 * - `contradiction`: the same block height now carries a DIFFERENT hash. This is proof.
 * - `absence`: a block we held is simply not present in the re-fetched range. This is an
 *   INFERENCE, and it is indistinguishable from a sender that under-delivered the range
 *   (a truncated `eth_getLogs`, a wrong address/topic filter). It still reverts state, so
 *   it is reported separately and loudly. See `docs/adr/0004`.
 */
export type ReorgCause = 'contradiction' | 'absence';

export type ReorgDetection = {cause: ReorgCause; blockNumber: number; blockHash: string};

export function wait(seconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

export type BlockOfEvents<ABI extends Abi> = {hash: string; number: number; events: LogEvent<ABI>[]};

export function groupLogsPerBlock<ABI extends Abi>(logEvents: LogEvent<ABI>[]): BlockOfEvents<ABI>[] {
	const groups: {[hash: string]: BlockOfEvents<ABI>} = {};
	const logEventsGroupedPerBlock: BlockOfEvents<ABI>[] = [];
	for (const event of logEvents) {
		if (event.removed) {
			// we skip event removed as we deal with them manually
			// we do not even expect them to be possible here
			// the system is designed to be operating with stateless eth_getLogs rather than stateful filter
			continue;
		}
		let group = groups[event.blockHash];
		if (!group) {
			group = groups[event.blockHash] = {
				hash: event.blockHash,
				number: event.blockNumber,
				events: [],
			};
			logEventsGroupedPerBlock.push(group);
		}
		group.events.push(event);
	}
	return logEventsGroupedPerBlock;
}

/**
 * Group an ALREADY-GENERATED stream for delivery, retractions included.
 *
 * This is the counterpart to `groupLogsPerBlock`, and the difference is the
 * whole point. `groupLogsPerBlock` groups logs coming IN from a fetch, where a
 * `removed` marker has no business existing and is dropped. This groups the
 * stream going OUT to a processor, where a `removed` marker is the retraction
 * itself and dropping it loses the only instruction to revert.
 *
 * Retracted and applied events are kept in SEPARATE groups even when they share
 * a block hash, which they genuinely can: when a reorg is detected at the first
 * unconfirmed block, every later unconfirmed block is retracted too, and a
 * re-fetch that still contains one of them re-applies it under the same hash.
 * Merging those two into one group would hand the processor a block that is
 * simultaneously retracted and applied.
 */
export function groupStreamPerBlock<ABI extends Abi>(
	stream: LogEvent<ABI>[],
): (BlockOfEvents<ABI> & {removed: boolean})[] {
	const groups = new Map<string, BlockOfEvents<ABI> & {removed: boolean}>();
	const ordered: (BlockOfEvents<ABI> & {removed: boolean})[] = [];
	for (const event of stream) {
		const removed = event.removed ? true : false;
		const key = `${removed ? 'R' : 'A'}:${event.blockHash}`;
		let group = groups.get(key);
		if (!group) {
			group = {hash: event.blockHash, number: event.blockNumber, events: [], removed};
			groups.set(key, group);
			ordered.push(group);
		}
		group.events.push(event);
	}
	return ordered;
}

export function generateStreamToAppend<ABI extends Abi>(
	lastSync: LastSync<ABI>,
	defaultFromBlock: number,
	newEvents: LogEvent<ABI>[],
	{
		newLatestBlock,
		newLastFromBlock,
		newLastToBlock,
		finality,
	}: {newLatestBlock: number; newLastFromBlock: number; newLastToBlock: number; finality: number},
): {eventStream: LogEvent<ABI>[]; newLastSync: LastSync<ABI>; reorg?: ReorgDetection} {
	const expectedFromBlock = getFromBlock(lastSync, defaultFromBlock, finality);

	if (newLastFromBlock !== expectedFromBlock) {
		// Typed, because this refusal IS the resumption protocol of ADR-0004: the
		// receiving side answers with the block the sender must re-send from, and a
		// caller that had to parse that number out of the message would break the
		// next time the message was reworded. Thrown from HERE, before a single
		// event is shaped, so a refused batch applies nothing by construction.
		throw new UnexpectedFromBlockError(expectedFromBlock, newLastFromBlock);
	}

	const logEventsGroupedPerBlock = groupLogsPerBlock(newEvents);
	const eventStream: LogEvent<ABI>[] = [];

	const lastUnconfirmedBlocks = lastSync.unconfirmedBlocks;

	// find reorgs
	//
	// This is driven by the blocks we previously held as unconfirmed, NOT by the incoming list.
	// A reorg can REMOVE a block's logs without replacing them at another block-with-logs (the
	// transaction went back to the mempool and is not re-mined yet), in which case the re-fetch
	// legitimately returns FEWER blocks than we hold. Iterating the incoming list would then
	// never look at the vanished block, so its events would never be retracted and it would
	// later be pruned from unconfirmedBlocks silently, baking the dead branch into the state.
	//
	// Incoming blocks are therefore matched by block NUMBER: a missing entry (block no longer
	// has any of our logs) and a differing hash (block replaced) are both a reorg at that block.
	const newBlockHashPerNumber = new Map<number, string>();
	for (const block of logEventsGroupedPerBlock) {
		newBlockHashPerNumber.set(block.number, block.hash);
	}

	let reorgBlock: EventBlock<ABI> | undefined;
	let reorgCause: ReorgCause | undefined;
	let reorgedBlockIndex = 0;
	for (let i = 0; i < lastUnconfirmedBlocks.length; i++) {
		const unconfirmedBlock = lastUnconfirmedBlocks[i];
		if (unconfirmedBlock.number < newLastFromBlock || unconfirmedBlock.number > newLastToBlock) {
			// the re-fetch did not cover this block, so its absence proves nothing
			reorgedBlockIndex = i + 1;
			continue;
		}
		const newHashAtSameHeight = newBlockHashPerNumber.get(unconfirmedBlock.number);
		if (newHashAtSameHeight !== unconfirmedBlock.hash) {
			reorgBlock = unconfirmedBlock;
			// A CONTRADICTION is proof: the same height now carries a different block.
			// An ABSENCE is an inference: the block simply is not in the payload, which is
			// indistinguishable from a sender that under-delivered the range (a truncated
			// eth_getLogs, a wrong filter). Both revert state, so the two are reported
			// separately: a rising rate of absence-driven reverts means truncation or
			// misconfiguration, not chain activity. See docs/adr/0004.
			reorgCause = newHashAtSameHeight === undefined ? 'absence' : 'contradiction';
			reorgedBlockIndex = i;
			break;
		}
		reorgedBlockIndex = i + 1;
	}

	if (reorgBlock && reorgCause) {
		const detail = {
			cause: reorgCause,
			blockNumber: reorgBlock.number,
			blockHash: reorgBlock.hash,
			fromBlock: newLastFromBlock,
			toBlock: newLastToBlock,
		};
		if (reorgCause === 'absence') {
			namedLogger.error(
				`reorg concluded from ABSENCE: block ${reorgBlock.number} (${reorgBlock.hash}) carries no logs in the re-fetched range [${newLastFromBlock}, ${newLastToBlock}]. State will be reverted. If this is frequent, suspect a truncated log fetch or a wrong filter rather than chain reorgs.`,
				detail,
			);
		} else {
			namedLogger.info(`reorg detected at block ${reorgBlock.number} (${reorgBlock.hash} replaced)`, detail);
		}
	}

	if (reorgBlock) {
		// re-add event to the stream but flag them as removed
		for (let i = reorgedBlockIndex; i < lastUnconfirmedBlocks.length; i++) {
			for (const event of lastUnconfirmedBlocks[i].events) {
				eventStream.push({
					...event,
					removed: true,
				});
			}
		}
	}

	const startingBlockForNewEvent = reorgBlock
		? reorgBlock.number
		: lastUnconfirmedBlocks.length > 0
			? lastUnconfirmedBlocks[lastUnconfirmedBlocks.length - 1].number + 1
			: logEventsGroupedPerBlock.length > 0
				? logEventsGroupedPerBlock[0].number
				: 0;
	// the case for 0 is a void case as none of the loop below will be triggered

	// new events and new unconfirmed blocks
	const newUnconfirmedBlocks: EventBlock<ABI>[] = [];

	// re-add older unconfirmed blocks that might get reorg later still
	// only if they are new enough (finality check)
	for (const unconfirmedBlock of lastUnconfirmedBlocks) {
		if (unconfirmedBlock.number < startingBlockForNewEvent) {
			if (newLastToBlock - unconfirmedBlock.number <= finality) {
				newUnconfirmedBlocks.push(unconfirmedBlock);
			}
		}
	}

	for (const block of logEventsGroupedPerBlock) {
		const isUnconfirmedBlock = newLatestBlock - block.number <= finality;
		if (block.events.length > 0 && block.number >= startingBlockForNewEvent) {
			const newEventsPerBlock: LogEvent<ABI>[] = [];
			for (const event of block.events) {
				eventStream.push(event);
				if (isUnconfirmedBlock) {
					newEventsPerBlock.push({...event});
				}
			}
			if (isUnconfirmedBlock) {
				newUnconfirmedBlocks.push({
					hash: block.hash,
					number: block.number,
					events: newEventsPerBlock,
				});
			}
		}
	}

	return {
		eventStream,
		newLastSync: {
			context: lastSync.context,
			lastFromBlock: newLastFromBlock,
			latestBlock: newLatestBlock,
			lastToBlock: newLastToBlock,
			unconfirmedBlocks: newUnconfirmedBlocks,
		},
		reorg:
			reorgBlock && reorgCause
				? {cause: reorgCause, blockNumber: reorgBlock.number, blockHash: reorgBlock.hash}
				: undefined,
	};
}

export function getFromBlock<ABI extends Abi>(
	lastSync: LastSync<ABI>,
	defaultFromBlock: number,
	finality: number,
): number {
	return lastSync.latestBlock === 0
		? defaultFromBlock
		: Math.max(Math.min(lastSync.lastToBlock + 1, lastSync.latestBlock - finality), 0);
}

/**
 * The earliest block a source can have anything to say about: the lowest
 * `startBlock` among its contracts, or 0 when any of them declares none.
 *
 * Extracted so the two things that need it -- the single-process
 * `EthereumIndexer` and the receive-only `StreamBuilder` -- read the same
 * answer. It is the floor `getFromBlock` returns before anything has been
 * indexed, so two implementations of it would put the two deployment shapes on
 * two different first batches.
 */
export function defaultFromBlockOf<ABI extends Abi>(source: IndexingSource<ABI>): number {
	let fromBlockFromContracts: undefined | number;
	if (Array.isArray(source.contracts)) {
		for (const contractData of source.contracts) {
			if (contractData.startBlock) {
				if (fromBlockFromContracts === undefined || contractData.startBlock < fromBlockFromContracts) {
					fromBlockFromContracts = contractData.startBlock;
				}
			} else {
				fromBlockFromContracts = 0;
			}
		}
	} else {
		fromBlockFromContracts = (source.contracts as unknown as AllContractData<ABI>).startBlock || 0;
	}
	return fromBlockFromContracts || 0;
}

/**
 * Whether a persisted `lastSync` describes the source and stream config we are
 * running now.
 *
 * It answers about the first two identities only; `context.processor` is
 * compared separately by the caller, because the two mismatches mean different
 * things (a processor upgrade is expected and routine, a source change is not).
 *
 * A source entry the stored context does not have is only a mismatch if it could
 * have contributed: a contract whose `startBlock` is above what was indexed had
 * nothing to say yet, so adding it does not invalidate what came before.
 */
export function indexerMatches(
	// this is the indexer settings to be applied
	indexerSourceHashes: {startBlock: number; hash: string}[],
	indexerConfigHash: string,
	// this is the stream loaded
	lastToBlock: number,
	context: ContextIdentifier,
	// if they do not match the indexer will take over and restart from zero
): boolean {
	if (context.config !== indexerConfigHash) {
		return false;
	}

	for (let i = 0; i < indexerSourceHashes.length; i++) {
		const indexerSourceItem = indexerSourceHashes[i];
		const fetchedSourceItem = context.source[i];
		if (fetchedSourceItem) {
			if (indexerSourceItem.hash !== fetchedSourceItem.hash) {
				return false;
			}
		} else {
			if (indexerSourceItem.startBlock <= lastToBlock) {
				return false;
			}
		}
	}
	// no mismatch found
	return true;
}
