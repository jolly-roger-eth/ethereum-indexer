import type {Abi} from 'abitype';
import {logs} from 'named-logs';
import {UnexpectedFromBlockError} from '../../errors.js';
import type {
	AllContractData,
	ContextIdentifier,
	EventBlock,
	IndexingSource,
	LastSync,
	LogEvent,
	ProvidedStreamConfig,
	SourceHashEntry,
	UsedStreamConfig,
	WireContext,
} from '../../types.js';
import {simple_hash} from '../../utils/hash.js';

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

export type InvalidationReason = 'stream-config' | 'entry-changed' | 'entry-added' | 'entry-removed';

/**
 * WHETHER one half of the stored data is still valid, and FROM WHICH BLOCK it
 * stopped being so.
 *
 * The block is deliberately part of the answer even though the only thing acting
 * on it today is "therefore discard everything and re-index from the start
 * block". A later refinement wants to BRANCH the stream at the boundary instead:
 * with the cursor at 900 and an entry appended at 780, blocks `0..779` were
 * fetched under a filter that was correct and complete, so only `780..900`
 * actually needs re-fetching. Collapsing this into a bare boolean, or burying
 * "re-index from the start block" inside the comparison, would make that a
 * rewrite instead of a refinement. See
 * `work/notes/ideas/a-stream-branches-instead-of-being-discarded.md`.
 */
export type InvalidationVerdict =
	| {valid: true}
	| {
			valid: false;
			/** The lowest block at which the stored data stopped describing this source. */
			invalidFromBlock: number;
			reason: InvalidationReason;
	  };

/**
 * The TWO verdicts, because the fetch and the fold do not depend on the same
 * thing and one verdict could not say so.
 *
 * - `stream` is about the raw logs, fetched under a topic-and-address filter. It
 *   survives everything that did not GROW that filter, so a shrunken topic set
 *   leaves a strict SUPERSET, which is reusable: decode less.
 * - `state` is about the fold over DECODED events. It dies whenever the decoding
 *   shape moved, even if not one log needs re-fetching.
 *
 * A renamed non-indexed parameter is the case that proves they are two
 * questions: `topic0` hashes types and not names, so the fetch is untouched and
 * the decode is not.
 *
 * The implication runs ONE WAY, by construction rather than by rule: an invalid
 * stream is always an invalid state too, because everything `streamHash` commits
 * to (the address, the `topic0`, the range) is also committed to by `hash`, so
 * nothing can move the filter without moving the decode. The converse is exactly
 * what this type exists to express.
 */
export type SourceInvalidation = {
	state: InvalidationVerdict;
	stream: InvalidationVerdict;
};

/** A source-hash list written by the code that hashed the WHOLE source into one entry. */
function isWholeSourceContext(entries: readonly SourceHashEntry[]): boolean {
	return entries.length === 1 && entries[0].startBlock === 0 && entries[0].streamHash === undefined;
}

/**
 * The diff between two entry lists, as SETS rather than element-wise by index.
 *
 * By index was workable while every entry was per-RANGE and the list was ordered
 * by `startBlock`, so an append landed at the end. It is not workable now that
 * an un-ranged source puts every one of its events at the same block: inserting
 * an event shifts whatever sorts after it, and every shifted entry would read as
 * a change to something already indexed. A set diff asks the question that was
 * always meant -- which entries are NEW, which are GONE -- and is immune to
 * where they land.
 *
 * `removalInvalidates` is the whole of the stream/state difference. A removed
 * entry means state was folded from an event we no longer index, so the state is
 * stale; but it means the filter only ever asked for MORE than it now needs, so
 * the stream is a superset and stands.
 *
 * The MINIMUM matching block is reported rather than the first one found, so the
 * answer is the earliest block that stopped being valid rather than an artefact
 * of list order.
 */
function verdictOn(
	current: readonly SourceHashEntry[],
	stored: readonly SourceHashEntry[],
	digestOf: (entry: SourceHashEntry) => string,
	lastToBlock: number,
	removalInvalidates: boolean,
): InvalidationVerdict {
	const storedDigests = new Set(stored.map(digestOf));
	const currentDigests = new Set(current.map(digestOf));
	const added = current.filter((entry) => !storedDigests.has(digestOf(entry)));
	const removed = removalInvalidates ? stored.filter((entry) => !currentDigests.has(digestOf(entry))) : [];
	const addedBlocks = new Set(added.map((entry) => entry.startBlock));
	const removedBlocks = new Set(removed.map((entry) => entry.startBlock));

	let invalidFromBlock: number | undefined;
	let reason: InvalidationReason | undefined;
	const invalidFrom = (block: number, why: InvalidationReason) => {
		if (invalidFromBlock === undefined || block < invalidFromBlock) {
			invalidFromBlock = block;
			reason = why;
		}
	};

	// An entry the stored context LACKS only invalidates if it could have
	// contributed: an event (or a contract) that starts above what was indexed had
	// nothing to say yet, so appending it costs nothing.
	for (const entry of added) {
		if (entry.startBlock <= lastToBlock) {
			invalidFrom(entry.startBlock, removedBlocks.has(entry.startBlock) ? 'entry-changed' : 'entry-added');
		}
	}
	for (const entry of removed) {
		if (entry.startBlock <= lastToBlock) {
			invalidFrom(entry.startBlock, addedBlocks.has(entry.startBlock) ? 'entry-changed' : 'entry-removed');
		}
	}

	if (invalidFromBlock === undefined || reason === undefined) {
		return {valid: true};
	}
	return {valid: false, invalidFromBlock, reason};
}

/**
 * Whether a persisted `lastSync` describes the source and stream config we are
 * running now, from where it stopped doing so, and SEPARATELY for the raw log
 * stream and for the state folded out of it.
 *
 * It answers about the first two identities only; `context.processor` is
 * compared separately by the caller, because the two mismatches mean different
 * things (a processor upgrade is expected and routine, a source change is not).
 *
 * A differing stream config invalidates EVERYTHING, from block 0, on both
 * halves: it is hashed into the wire identity and describes how logs were
 * fetched as much as what they meant.
 *
 * ## Reading a context written before this split
 *
 * `ContextIdentifier` is PERSISTED, so a stored context has to be readable
 * whatever version wrote it. There are three shapes, and a context that does not
 * describe a changed source must never read as invalid -- that would silently
 * re-index every existing deployment on upgrade, which is the exact cost
 * per-event hashing removes.
 *
 * - **per-event** (what this code writes): both halves are decided
 *   independently.
 * - **per-range, no `streamHash`** (what the ranged path wrote): the `hash` of
 *   every entry is computed exactly as it was, so the set diff on `hash` matches
 *   byte for byte and the state verdict is unchanged. The stored entries say
 *   nothing about the FILTER they were fetched under, so the stream half falls
 *   back to the state verdict rather than guessing.
 * - **one whole-source entry** (what an un-ranged source wrote): a digest over
 *   bytes no per-event entry reproduces, so it is compared against the one thing
 *   that does reproduce them, `legacyHash` on the block-0 entry. Equal means the
 *   source did not move and NOTHING is invalidated; unequal means it did, and
 *   the old entry cannot say where, so both halves go from block 0 exactly as
 *   they did before. Either way the next save writes the per-event list, so a
 *   deployment pays this at most once.
 */
export function sourceInvalidationOf(
	// this is the indexer settings to be applied
	indexerSourceHashes: SourceHashEntry[],
	indexerConfigHash: string,
	// this is the stream loaded
	lastToBlock: number,
	context: ContextIdentifier,
): SourceInvalidation {
	if (context.config !== indexerConfigHash) {
		const bothHalves = {valid: false, invalidFromBlock: 0, reason: 'stream-config'} as const;
		return {state: bothHalves, stream: bothHalves};
	}

	const stored = context.source;
	const legacyHash = indexerSourceHashes[0]?.legacyHash;
	if (legacyHash !== undefined && isWholeSourceContext(stored)) {
		if (stored[0].hash === legacyHash) {
			return {state: {valid: true}, stream: {valid: true}};
		}
		const bothHalves = {valid: false, invalidFromBlock: 0, reason: 'entry-changed'} as const;
		return {state: bothHalves, stream: bothHalves};
	}

	const state = verdictOn(indexerSourceHashes, stored, (entry) => entry.hash, lastToBlock, true);
	const bothSidesKnowTheFilter =
		indexerSourceHashes.every((entry) => entry.streamHash !== undefined) &&
		stored.every((entry) => entry.streamHash !== undefined);
	const stream = bothSidesKnowTheFilter
		? verdictOn(indexerSourceHashes, stored, (entry) => entry.streamHash as string, lastToBlock, false)
		: state;
	return {state, stream};
}

/**
 * Whether the persisted STATE is still a fold over what this source means.
 *
 * The narrow surface the callers that only ever discard everything want;
 * `sourceInvalidationOf` is where the block lives, so acting on it later does
 * not mean re-deriving the rule.
 */
export function stateMatches(
	// this is the indexer settings to be applied
	indexerSourceHashes: SourceHashEntry[],
	indexerConfigHash: string,
	// this is the stream loaded
	lastToBlock: number,
	context: ContextIdentifier,
	// if they do not match the indexer will take over and restart from zero
): boolean {
	return sourceInvalidationOf(indexerSourceHashes, indexerConfigHash, lastToBlock, context).state.valid;
}

/**
 * Whether the cached raw log STREAM was fetched under a filter this source is
 * still covered by.
 *
 * Deliberately a different question from `stateMatches`, and a weaker one: the
 * stream is reusable whenever the topic-and-address filter did not GROW, so a
 * discarded state can still be rebuilt from it without going back to the node.
 */
export function streamMatches(
	indexerSourceHashes: SourceHashEntry[],
	indexerConfigHash: string,
	lastToBlock: number,
	context: ContextIdentifier,
): boolean {
	return sourceInvalidationOf(indexerSourceHashes, indexerConfigHash, lastToBlock, context).stream.valid;
}

/**
 * The stream config as it is actually USED, defaults filled in.
 *
 * One implementation, because the resolved object is HASHED into the wire
 * identity: `EthereumIndexer`, the receiving `StreamBuilder` and the sending
 * `LogFetcher` must all reach the same `finality` from the same input, or two
 * halves of one deployment would compute different `config` hashes and every
 * batch would be refused with a digest neither side can read.
 */
export function resolveStreamConfig(stream: ProvidedStreamConfig | undefined): UsedStreamConfig {
	return {finality: 17, ...(stream || {})};
}

/**
 * The `{source, config}` identity a sender asserts and a receiver checks.
 *
 * Derived here rather than at each end, for the same reason `getFromBlock` is:
 * the two halves of the wire must compute the SAME digest from the same
 * declarations, and a second implementation of it is a mismatch waiting to
 * happen. `context.processor` is deliberately absent -- a log-fetcher has no way
 * to know which processor version runs on the other side (ADR-0004).
 */
export function wireContextOf<ABI extends Abi>(
	source: IndexingSource<ABI>,
	streamConfig: UsedStreamConfig,
): WireContext {
	return {
		source: [{startBlock: 0, hash: simple_hash(source)}],
		config: simple_hash(streamConfig),
	};
}

/** Whether two wire identities name the same indexer. */
export function sameWireContext(a: WireContext | undefined, b: WireContext | undefined): boolean {
	if (!a || !b || !Array.isArray(a.source) || !Array.isArray(b.source)) {
		return false;
	}
	return (
		a.config === b.config &&
		a.source.length === b.source.length &&
		a.source.every((entry, i) => b.source[i]?.hash === entry.hash)
	);
}
