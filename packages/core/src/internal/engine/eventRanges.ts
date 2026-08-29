import type {Abi, AbiEvent} from 'abitype';
import {canonicalSignatureOf, decodingShapeOf, describeEventDeclaration} from '../decoding/eventIdentity.js';
import type {AllContractData, ContractData, IndexingSource, RangedAbiEvent} from '../../types.js';
import {simple_hash} from '../../utils/hash.js';

/**
 * AN EVENT IS LIVE OVER BLOCK RANGES, and this is where the declaration becomes
 * a normalised, invalidation-ready form.
 *
 * The ranges are used for exactly two things and no others: whether a source
 * change can be absorbed without re-fetching (here, via `sourceHashesOf`), and
 * -- later -- which topics a given block range needs to request. They are NOT a
 * decoding concern: a log is decoded by its `topic0`, with no block axis, since
 * two versions with different signatures are told apart on the wire and two
 * versions sharing a `topic0` cannot be told apart by a boundary either (the
 * upgrade transaction sits mid-block, so both meanings share a block).
 */

/** A span of blocks an event is live over. Both bounds INCLUSIVE; no `lastBlock` means open-ended. */
export type EventBlockRange = {readonly firstBlock: number; readonly lastBlock?: number};

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
 * Whether ANY event entry in the source declares a range.
 *
 * The whole point of asking: a source that declares none must behave EXACTLY as
 * it did before ranges existed, down to the persisted context bytes, so no
 * deployment changes behaviour merely by upgrading.
 */
export function sourceDeclaresEventRanges<ABI extends Abi>(source: IndexingSource<ABI>): boolean {
	const abis = Array.isArray(source.contracts)
		? (source.contracts as readonly ContractData<ABI>[]).map((contract) => contract.abi)
		: [(source.contracts as AllContractData<ABI>).abi];
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
	const contracts: {address?: `0x${string}`; abi: Abi; startBlock: number}[] = Array.isArray(source.contracts)
		? (source.contracts as readonly ContractData<ABI>[]).map((contract) => ({
				address: contract.address,
				abi: contract.abi,
				startBlock: contract.startBlock ?? 0,
			}))
		: [
				{
					abi: (source.contracts as AllContractData<ABI>).abi,
					startBlock: (source.contracts as AllContractData<ABI>).startBlock ?? 0,
				},
			];

	const live: LiveEvent[] = [];
	for (const contract of contracts) {
		// insertion-ordered, so the output follows the ABI rather than a hash order
		const perSignature = new Map<string, {event: AbiEvent; ranges: EventBlockRange[]}>();
		for (const item of contract.abi) {
			if (item.type !== 'event') continue;
			const event = item as AbiEvent;
			const signature = canonicalSignatureOf(event);
			const range = declaredRangeOf(event, contract.startBlock) ?? {firstBlock: contract.startBlock};
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
 * The `{startBlock, hash}[]` a `ContextIdentifier` carries, computed from the
 * NORMALISED ranges rather than from the raw ABI list.
 *
 * Normalised is load-bearing: `indexerMatches` compares element-wise BY INDEX,
 * so a redundant appended entry (the rollback a generator cannot recognise)
 * would otherwise shift every later entry and re-index the world. Normalised, it
 * produces a byte-identical list and costs nothing.
 *
 * Entries are ordered by `startBlock` so that an APPEND lands at the END of the
 * list, which is the shape `indexerMatches` reads as "the stored context simply
 * did not have this yet". The entry at block 0 is the source skeleton and stays
 * first.
 *
 * A source that declares NO range produces exactly what it has always produced:
 * one entry, at block 0, hashing the whole source. That is deliberate rather
 * than incidental -- `ContextIdentifier` is persisted, and this is what makes
 * every existing stored context still match, with no migration.
 */
export function sourceHashesOf<ABI extends Abi>(source: IndexingSource<ABI>): {startBlock: number; hash: string}[] {
	if (!sourceDeclaresEventRanges(source)) {
		return [{startBlock: 0, hash: simple_hash(source)}];
	}

	const eventEntries: {startBlock: number; hash: string}[] = [];
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
			});
		}
	}
	eventEntries.sort((a, b) => a.startBlock - b.startBlock || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));

	return [{startBlock: 0, hash: simple_hash(sourceSkeletonOf(source))}, ...eventEntries];
}
