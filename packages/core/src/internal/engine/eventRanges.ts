import type {Abi, AbiEvent} from 'abitype';
import {canonicalSignatureOf, decodingShapeOf, describeEventDeclaration, topic0Of} from '../decoding/eventIdentity.js';
import type {AllContractData, ContractData, IndexingSource, RangedAbiEvent, SourceHashEntry} from '../../types.js';
import {simple_hash} from '../../utils/hash.js';

/**
 * AN EVENT IS LIVE OVER BLOCK RANGES, and this is where the declaration becomes
 * a normalised form the rest of the indexer can act on.
 *
 * The ranges are used for exactly two things and no others: whether a source
 * change can be absorbed without re-fetching (here, via `sourceHashesOf`), and
 * which topics a given block range needs to request (here, via
 * `requestableRangesPerTopic`, read by `RangeLogFetcher`). They are NOT a
 * decoding concern: a log is decoded by its `topic0`, with no block axis, since
 * two versions with different signatures are told apart on the wire and two
 * versions sharing a `topic0` cannot be told apart by a boundary either (the
 * upgrade transaction sits mid-block, so both meanings share a block).
 */

/** A span of blocks an event is live over. Both bounds INCLUSIVE; no `lastBlock` means open-ended. */
export type EventBlockRange = {readonly firstBlock: number; readonly lastBlock?: number};

/** The contracts half of an `IndexingSource`, which is all either reading here needs. */
type ContractsData<ABI extends Abi> = IndexingSource<ABI>['contracts'];

/** One contract, with the first block an event that DECLARES nothing is live from. */
type ContractEntry = {address?: `0x${string}`; abi: Abi; defaultFirstBlock: number};

/**
 * The live ranges of each `topic0` in a fetch filter, unioned across contracts.
 *
 * An EMPTY map means nothing declared a range, so nothing narrows.
 */
export type TopicBlockRanges = ReadonlyMap<`0x${string}`, readonly EventBlockRange[]>;

/**
 * One event of one contract, with the ranges it is live over, NORMALISED.
 *
 * `address` is absent for the single-ABI (`AllContractData`) shape, which names
 * no address at all.
 */
export type LiveEvent = {
	readonly address?: `0x${string}`;
	readonly signature: string;
	readonly event: AbiEvent;
	readonly ranges: readonly EventBlockRange[];
};

/** Both a refusal message can be searched for: the canonical signature and the readable declaration. */
function nameOf(event: AbiEvent): string {
	return `${canonicalSignatureOf(event)} (\`${describeEventDeclaration(event)}\`)`;
}

function assertBlockNumber(value: number, field: 'firstBlock' | 'lastBlock', event: AbiEvent): void {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error(`invalid \`${field}\` on ${nameOf(event)}: ${value} is not a whole non-negative block number.`);
	}
}

/** The range one ABI entry declares, defaulted against the contract's own `startBlock`. */
function declaredRangeOf(event: AbiEvent, contractStartBlock: number): EventBlockRange | undefined {
	const {firstBlock, lastBlock} = event as RangedAbiEvent;
	if (firstBlock === undefined && lastBlock === undefined) {
		return undefined;
	}
	if (firstBlock !== undefined) {
		assertBlockNumber(firstBlock, 'firstBlock', event);
	}
	if (lastBlock !== undefined) {
		assertBlockNumber(lastBlock, 'lastBlock', event);
	}
	const from = firstBlock ?? contractStartBlock;
	if (lastBlock !== undefined && lastBlock < from) {
		throw new Error(
			`invalid block range on ${nameOf(event)}: lastBlock ${lastBlock} is before firstBlock ${from}. ` +
				`Both bounds are INCLUSIVE, so an upgrade at block b is declared \`lastBlock: b\` on the old event and \`firstBlock: b\` on the new one.`,
		);
	}
	return {firstBlock: from, ...(lastBlock === undefined ? {} : {lastBlock})};
}

/**
 * Whether ANY event entry in these contracts declares a range.
 *
 * Asked by ONE reader, `requestableRangesPerTopic`, and the whole point of
 * asking is there: a source that declares no range must REQUEST exactly what it
 * always requested, topic for topic, so nothing narrows until something
 * declares. INVALIDATION does not ask, because it hashes per event either way.
 */
export function contractsDeclareEventRanges<ABI extends Abi>(contracts: ContractsData<ABI>): boolean {
	const abis = Array.isArray(contracts)
		? (contracts as readonly ContractData<ABI>[]).map((contract) => contract.abi)
		: [(contracts as AllContractData<ABI>).abi];
	for (const abi of abis) {
		for (const item of abi) {
			if (item.type !== 'event') continue;
			const {firstBlock, lastBlock} = item as RangedAbiEvent;
			if (firstBlock !== undefined || lastBlock !== undefined) {
				return true;
			}
		}
	}
	return false;
}

/**
 * Collapse every occurrence of ONE event into the ranges it is live over.
 *
 * This is what makes a naive generator cheap. Whatever produces the source
 * usually cannot tell an upgrade from a cancellation: it sees a proxy upgrade
 * and appends an entry, and on a rollback appends another, so a source can
 * legitimately read `[A@a, B@b, A@c]`.
 *
 * - if ANY occurrence is OPEN-ENDED, the event is live from the MINIMUM
 *   `firstBlock` onward and every other occurrence is absorbed. That is the SAFE
 *   reading as well as the simple one: if A really was dead between `b` and `c`,
 *   keeping it live over that span costs a little fetching and loses nothing;
 * - otherwise the event is live over the UNION of its ranges, with touching and
 *   overlapping spans joined.
 *
 * A GAP is refused. Overlap is fine -- an upgrade at block `b` produces a
 * deliberate one-block overlap -- but a hole is a span nobody requests, and
 * afterwards nothing distinguishes "the chain had none" from "we never asked".
 */
function normalizeRanges(ranges: EventBlockRange[], event: AbiEvent, address?: `0x${string}`): EventBlockRange[] {
	const openEnded = ranges.filter((range) => range.lastBlock === undefined);
	if (openEnded.length > 0) {
		return [{firstBlock: Math.min(...ranges.map((range) => range.firstBlock))}];
	}

	const sorted = [...ranges].sort((a, b) => a.firstBlock - b.firstBlock);
	const merged: EventBlockRange[] = [sorted[0]];
	for (const range of sorted.slice(1)) {
		const previous = merged[merged.length - 1];
		const previousLast = previous.lastBlock as number;
		if (range.firstBlock > previousLast + 1) {
			const where = address ? ` at ${address}` : '';
			throw new Error(
				`gap in the block ranges of ${nameOf(event)}${where}: ` +
					`blocks ${previousLast + 1}..${range.firstBlock - 1} are covered by no range, so that event would be requested by nobody there. ` +
					`Extend a range to cover it (both bounds are INCLUSIVE), or drop the \`lastBlock\` to leave the event open-ended.`,
			);
		}
		merged[merged.length - 1] = {
			firstBlock: previous.firstBlock,
			lastBlock: Math.max(previousLast, range.lastBlock as number),
		};
	}
	return merged;
}

/**
 * Every event the source declares, with its NORMALISED live ranges.
 *
 * Grouped per CONTRACT and then per event identity (the canonical signature,
 * which is what `topic0` hashes), because two contracts have independent
 * lifetimes: one address going quiet is not a hole in another address's
 * coverage.
 *
 * An event that declares nothing is live from its contract's `startBlock`
 * onward, which is what it has always meant.
 */
export function liveEventsOf<ABI extends Abi>(source: IndexingSource<ABI>): LiveEvent[] {
	return liveEventsIn(contractEntriesOf(source.contracts, FROM_THE_CONTRACT_START_BLOCK));
}

/** For INVALIDATION: an event that declares nothing is live from its contract's `startBlock`. */
const FROM_THE_CONTRACT_START_BLOCK = (contract: {startBlock?: number}) => contract.startBlock ?? 0;

/** For the FETCH FILTER: it is live from block 0 instead -- see `requestableRangesPerTopic`. */
const FROM_BLOCK_ZERO = () => 0;

/** What the two callers of `liveEventsIn` disagree about is ONLY the default first block. */
function contractEntriesOf<ABI extends Abi>(
	contracts: ContractsData<ABI>,
	defaultFirstBlockOf: (contract: {startBlock?: number}) => number,
): ContractEntry[] {
	return Array.isArray(contracts)
		? (contracts as readonly ContractData<ABI>[]).map((contract) => ({
				address: contract.address,
				abi: contract.abi,
				defaultFirstBlock: defaultFirstBlockOf(contract),
			}))
		: [
				{
					abi: (contracts as AllContractData<ABI>).abi,
					defaultFirstBlock: defaultFirstBlockOf(contracts as AllContractData<ABI>),
				},
			];
}

function liveEventsIn(contracts: readonly ContractEntry[]): LiveEvent[] {
	const live: LiveEvent[] = [];
	for (const contract of contracts) {
		// insertion-ordered, so the output follows the ABI rather than a hash order
		const perSignature = new Map<string, {event: AbiEvent; ranges: EventBlockRange[]}>();
		for (const item of contract.abi) {
			if (item.type !== 'event') continue;
			const event = item as AbiEvent;
			const signature = canonicalSignatureOf(event);
			const range = declaredRangeOf(event, contract.defaultFirstBlock) ?? {firstBlock: contract.defaultFirstBlock};
			const group = perSignature.get(signature);
			if (group) {
				group.ranges.push(range);
			} else {
				perSignature.set(signature, {event, ranges: [range]});
			}
		}
		for (const [signature, group] of perSignature) {
			live.push({
				...(contract.address === undefined ? {} : {address: contract.address}),
				signature,
				event: group.event,
				ranges: normalizeRanges(group.ranges, group.event, contract.address),
			});
		}
	}
	return live;
}

/**
 * The live ranges of each `topic0`, as the FETCH FILTER must read them.
 *
 * EMPTY when nothing in the source declares a range, which is what makes such a
 * source request exactly what it always requested, topic for topic.
 *
 * Two things separate this from `liveEventsOf`, and both exist because this is
 * the one reading that REMOVES a topic from a request.
 *
 * - An event that DECLARES nothing is live from block **0**, open-ended, rather
 *   than from its contract's `startBlock`. `startBlock` means "do not look
 *   before here" per contract and is MINIMISED across contracts by
 *   `defaultFromBlockOf`, so a range below one contract's `startBlock` is still
 *   fetched with that contract's address in the filter; narrowing on it would
 *   drop an event nobody gave a range, and adding a range to ONE event would
 *   silently change what an UNRELATED event fetches. Every omission has to
 *   follow from a declaration. Invalidation defaults to `startBlock` instead
 *   because it is comparing coverage, not deciding what to ask for.
 * - Ranges are keyed by `topic0` and UNIONED across contracts, since the topic
 *   filter of an `eth_getLogs` request is global to the request while a range is
 *   declared per contract. Two contracts have independent lifetimes, so one
 *   address going quiet is not a hole in another's coverage, and the union is
 *   the only safe reading. (For the SAME reason the union is not re-normalised:
 *   a gap BETWEEN two contracts is not a gap in an event's coverage.)
 */
export function requestableRangesPerTopic<ABI extends Abi>(contracts: ContractsData<ABI>): TopicBlockRanges {
	const perTopic = new Map<`0x${string}`, EventBlockRange[]>();
	if (!contractsDeclareEventRanges(contracts)) {
		return perTopic;
	}
	for (const live of liveEventsIn(contractEntriesOf(contracts, FROM_BLOCK_ZERO))) {
		const topic0 = topic0Of(live.event);
		if (!topic0) {
			// an anonymous event carries no topic0, so it is in no filter to narrow
			continue;
		}
		const existing = perTopic.get(topic0);
		if (existing) {
			existing.push(...live.ranges);
		} else {
			perTopic.set(topic0, [...live.ranges]);
		}
	}
	return perTopic;
}

/**
 * Whether an event live over `ranges` can occur ANYWHERE in `[fromBlock,
 * toBlock]`, both inclusive.
 *
 * `undefined` ranges mean the event declared none, and an event that declared
 * nothing is never dropped. Same for an open-ended `lastBlock`: open-ended is
 * the default and the safe case.
 *
 * A range that crosses a boundary matches both sides, which is the UNION rather
 * than a split. Requesting more than necessary is safe; requesting less is not.
 */
export function canOccurIn(
	ranges: readonly EventBlockRange[] | undefined,
	fromBlock: number,
	toBlock: number,
): boolean {
	if (!ranges) {
		return true;
	}
	return ranges.some(
		(range) => range.firstBlock <= toBlock && (range.lastBlock ?? Number.POSITIVE_INFINITY) >= fromBlock,
	);
}

/**
 * Everything about a source EXCEPT the ABIs: what a range cannot describe.
 *
 * Hashed into the entry at block 0, so a changed chain id, genesis hash,
 * address or `startBlock` still invalidates the whole indexed history, exactly
 * as it does today.
 */
function sourceSkeletonOf<ABI extends Abi>(source: IndexingSource<ABI>): unknown {
	return {
		chainId: source.chainId,
		genesisHash: source.genesisHash,
		contracts: Array.isArray(source.contracts)
			? (source.contracts as readonly ContractData<ABI>[]).map((contract) => ({
					address: contract.address,
					startBlock: contract.startBlock,
				}))
			: {startBlock: (source.contracts as AllContractData<ABI>).startBlock},
	};
}

/**
 * The `SourceHashEntry[]` a `ContextIdentifier` carries: one entry per
 * (contract, event, live range), computed from the NORMALISED ranges rather than
 * from the raw ABI list, over a leading SKELETON entry at block 0.
 *
 * PER EVENT WHETHER OR NOT A RANGE IS DECLARED. An ABI is REGENERATED and not
 * hand-edited, so the members that move most often are the ones no log depends
 * on: an added view function, a reordered array, an `internalType` a second
 * compilation spells differently. Hashing the whole source into one entry made
 * every one of those discard the state AND re-fetch all history. A non-event ABI
 * member therefore contributes to NOTHING here: a function is not indexed, does
 * not enter the fetch filter and cannot change what a log decodes to.
 *
 * The rest of the source is NOT free. `chainId`, `genesisHash`, a contract's
 * `address` and its `startBlock` are exactly what a range cannot describe, so
 * they are hashed into the block-0 entry and still invalidate everything.
 *
 * TWO DIGESTS PER ENTRY, because the fetch and the fold depend on different
 * things (see `SourceHashEntry`). `hash` is what the state is a fold over, so it
 * covers the decoding shape; `streamHash` is what the filter is built from, so
 * it covers the `topic0` and nothing about names. A renamed non-indexed
 * parameter moves the first and not the second, which is what lets the stream be
 * kept while the state is discarded.
 *
 * Normalisation is load-bearing: a redundant appended entry (the rollback a
 * generator cannot recognise) collapses away, so the list is byte-identical and
 * costs nothing. So is the ORDER: entries are sorted by `startBlock` and then by
 * `hash`, which makes the list a canonical set rather than a transcription of
 * the ABI array, so REORDERING the events in an ABI produces the same bytes.
 *
 * `hash` is deliberately computed exactly as the ranged path always computed it,
 * so a source that DECLARES ranges hashes byte-identically to what is already
 * persisted for it. The un-ranged case is the one that changes shape, and
 * `legacyHash` is what carries a stored context of that shape across (see
 * `sourceInvalidationOf`).
 */
export function sourceHashesOf<ABI extends Abi>(source: IndexingSource<ABI>): SourceHashEntry[] {
	const eventEntries: SourceHashEntry[] = [];
	for (const live of liveEventsOf(source)) {
		for (const range of live.ranges) {
			eventEntries.push({
				startBlock: range.firstBlock,
				hash: simple_hash({
					address: live.address,
					signature: live.signature,
					// hashed on what DECODING reads, so a regenerated ABI differing only in
					// `internalType` does not discard a user's whole indexed history
					shape: decodingShapeOf(live.event),
					firstBlock: range.firstBlock,
					lastBlock: range.lastBlock,
				}),
				// what the FETCH FILTER is built from, and nothing else. An ANONYMOUS event
				// contributes no `topic0` because it is in no filter to grow, so two of them
				// at one address over one range share a digest -- correctly, since neither
				// can widen what is requested.
				streamHash: simple_hash({
					address: live.address,
					topic0: topic0Of(live.event),
					firstBlock: range.firstBlock,
					lastBlock: range.lastBlock,
				}),
			});
		}
	}
	eventEntries.sort((a, b) => a.startBlock - b.startBlock || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));

	const skeleton = simple_hash(sourceSkeletonOf(source));
	return [
		// the skeleton is what the fetch and the fold BOTH rest on, so it is the same
		// digest twice rather than two questions with one answer
		{startBlock: 0, hash: skeleton, streamHash: skeleton, legacyHash: simple_hash(source)},
		...eventEntries,
	];
}
