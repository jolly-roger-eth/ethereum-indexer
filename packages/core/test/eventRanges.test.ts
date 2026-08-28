import type {Abi} from 'abitype';
import {describe, expect, it} from 'vitest';
import {liveEventsOf, sourceHashesOf} from '../src/internal/engine/eventRanges.js';
import {defaultFromBlockOf, indexerMatches, sourceInvalidationOf} from '../src/internal/engine/utils.js';
import {simple_hash} from '../src/utils/hash.js';
import type {ContextIdentifier, IndexingSource} from '../src/types.js';

// ---------------------------------------------------------------------------
// AN ABI EVENT IS LIVE OVER BLOCK RANGES
// ---------------------------------------------------------------------------
// An event is not a fact about a contract, it is a fact about a contract over a
// range of BLOCKS. Declaring that range is what lets an upgrade APPEND an entry
// instead of moving one whole-source hash and re-fetching every block ever
// indexed.
//
// The ranges are used for exactly one thing here: INVALIDATION. Decoding is by
// topic0 and has no block axis (see `fetchFilter.test.ts`), and narrowing what
// the fetcher REQUESTS per range is a separate, later change.
// ---------------------------------------------------------------------------

const A = '0x0000000000000000000000000000000000000001' as const;
const B = '0x0000000000000000000000000000000000000002' as const;

/** `Transfer(address,address,uint256)` -- the pre-upgrade signature. */
const transferV1 = {
	type: 'event',
	name: 'Transfer',
	anonymous: false,
	inputs: [
		{indexed: true, name: 'from', type: 'address'},
		{indexed: true, name: 'to', type: 'address'},
		{indexed: false, name: 'id', type: 'uint256'},
	],
} as const;

/** `Transfer(address,address,uint256,bytes)` -- the post-upgrade signature, a different topic0. */
const transferV2 = {
	type: 'event',
	name: 'Transfer',
	anonymous: false,
	inputs: [
		{indexed: true, name: 'from', type: 'address'},
		{indexed: true, name: 'to', type: 'address'},
		{indexed: false, name: 'id', type: 'uint256'},
		{indexed: false, name: 'memo', type: 'bytes'},
	],
} as const;

/** An unrelated event, so a source can gain one without touching `Transfer`. */
const approval = {
	type: 'event',
	name: 'Approval',
	anonymous: false,
	inputs: [
		{indexed: true, name: 'owner', type: 'address'},
		{indexed: true, name: 'approved', type: 'address'},
		{indexed: true, name: 'id', type: 'uint256'},
	],
} as const;

const withRange = (event: object, range: {firstBlock?: number; lastBlock?: number}) => ({...event, ...range});

function sourceOf(abi: unknown[], options: {address?: `0x${string}`; startBlock?: number} = {}): IndexingSource<Abi> {
	return {
		chainId: '1',
		contracts: [
			{
				abi: abi as unknown as Abi,
				address: options.address ?? A,
				startBlock: options.startBlock ?? 100,
			},
		],
	};
}

/** The ranges of the ONE event whose name matches, as `[first, last]` pairs. */
function rangesOf(source: IndexingSource<Abi>, signatureFragment: string): [number, number | undefined][] {
	return liveEventsOf(source)
		.filter((live) => live.signature.startsWith(signatureFragment))
		.flatMap((live) => live.ranges.map((range) => [range.firstBlock, range.lastBlock] as [number, number | undefined]));
}

const contextOf = (hashes: {startBlock: number; hash: string}[], config = 'cfg'): ContextIdentifier => ({
	source: hashes,
	config,
	processor: 'p',
});

// ---------------------------------------------------------------------------

describe('the range fields, which are not startBlock', () => {
	it('takes an inclusive firstBlock and an optional inclusive lastBlock off an event entry', () => {
		const source = sourceOf([
			withRange(transferV1, {firstBlock: 100, lastBlock: 900}),
			withRange(transferV2, {firstBlock: 900}),
		]);

		expect(rangesOf(source, 'Transfer(address,address,uint256)')).toEqual([[100, 900]]);
		expect(rangesOf(source, 'Transfer(address,address,uint256,bytes)')).toEqual([[900, undefined]]);
	});

	it('keeps the one-block overlap at an upgrade instead of collapsing it', () => {
		// A transaction earlier in block 900 still fires the old event while the
		// upgrade transaction later in that block starts the new one, so the SAME
		// number on both sides is the CORRECT declaration.
		const source = sourceOf([
			withRange(transferV1, {firstBlock: 100, lastBlock: 900}),
			withRange(transferV2, {firstBlock: 900}),
		]);

		const live = liveEventsOf(source);
		const coveringBlock900 = live.filter((event) =>
			event.ranges.some((range) => range.firstBlock <= 900 && (range.lastBlock ?? Infinity) >= 900),
		);
		expect(coveringBlock900.length).toBe(2);
	});

	it('does not let a range reach defaultFromBlock, which is contract startBlock alone', () => {
		// `defaultFromBlockOf` MINIMISES across entries, so a per-event range that
		// shared its name or its shape would silently drag the first fetched block
		// down to it.
		const source = sourceOf([withRange(transferV1, {firstBlock: 0})], {startBlock: 500});

		expect(defaultFromBlockOf(source)).toBe(500);
	});

	it('defaults an undeclared firstBlock to the contract startBlock', () => {
		const source = sourceOf([transferV1, withRange(approval, {firstBlock: 900})], {startBlock: 100});

		expect(rangesOf(source, 'Transfer')).toEqual([[100, undefined]]);
	});

	it('refuses a range that ends before it starts, naming the event', () => {
		const source = sourceOf([withRange(transferV1, {firstBlock: 900, lastBlock: 100})]);

		expect(() => liveEventsOf(source)).toThrow(/Transfer\(address,address,uint256\)/);
		expect(() => liveEventsOf(source)).toThrow(/900/);
	});

	it('refuses a block number that is not a whole non-negative number', () => {
		expect(() => liveEventsOf(sourceOf([withRange(transferV1, {firstBlock: -1})]))).toThrow(/firstBlock/);
		expect(() => liveEventsOf(sourceOf([withRange(transferV1, {lastBlock: 1.5})]))).toThrow(/lastBlock/);
	});
});

describe('normalisation, which is what makes a naive generator cheap', () => {
	it('absorbs a later occurrence into an open-ended one, from the MINIMUM firstBlock', () => {
		// The generator cannot tell an upgrade from a rollback: it saw a proxy
		// upgrade, appended B, then saw another and appended A again.
		const source = sourceOf([
			withRange(transferV1, {firstBlock: 100}),
			withRange(transferV2, {firstBlock: 400}),
			withRange(transferV1, {firstBlock: 700}),
		]);

		expect(rangesOf(source, 'Transfer(address,address,uint256)')).toEqual([[100, undefined]]);
		expect(rangesOf(source, 'Transfer(address,address,uint256,bytes)')).toEqual([[400, undefined]]);
	});

	it('unions the ranges when every occurrence is closed', () => {
		const source = sourceOf([
			withRange(transferV1, {firstBlock: 100, lastBlock: 400}),
			withRange(transferV1, {firstBlock: 300, lastBlock: 700}),
		]);

		expect(rangesOf(source, 'Transfer(address,address,uint256)')).toEqual([[100, 700]]);
	});

	it('joins two closed ranges that merely touch, since the coverage has no hole', () => {
		const source = sourceOf([
			withRange(transferV1, {firstBlock: 100, lastBlock: 400}),
			withRange(transferV1, {firstBlock: 401, lastBlock: 700}),
		]);

		expect(rangesOf(source, 'Transfer(address,address,uint256)')).toEqual([[100, 700]]);
	});

	it('refuses a GAP between consecutive ranges for one event, naming the event and the uncovered span', () => {
		// A hole is a span nobody requests, which is silent loss: afterwards nothing
		// distinguishes "the chain had none" from "we never asked". Only reachable
		// when EVERY occurrence is closed -- an open-ended one absorbs the rest.
		const source = sourceOf([
			withRange(transferV1, {firstBlock: 100, lastBlock: 400}),
			withRange(transferV1, {firstBlock: 700, lastBlock: 900}),
		]);

		expect(() => liveEventsOf(source)).toThrow(/Transfer\(address,address,uint256\)/);
		// the uncovered span, inclusive on both ends
		expect(() => liveEventsOf(source)).toThrow(/401/);
		expect(() => liveEventsOf(source)).toThrow(/699/);
	});

	it('absorbs every closed occurrence into an open-ended one, so no gap can survive it', () => {
		// The rollback case with a declared end: A was closed at 400 and later
		// reappeared open-ended, and the safe reading keeps A live throughout.
		const source = sourceOf([
			withRange(transferV1, {firstBlock: 100, lastBlock: 400}),
			withRange(transferV1, {firstBlock: 700}),
		]);

		expect(rangesOf(source, 'Transfer(address,address,uint256)')).toEqual([[100, undefined]]);
	});

	it('keeps two contracts apart, so one address cannot fill another address hole', () => {
		const source: IndexingSource<Abi> = {
			chainId: '1',
			contracts: [
				{
					abi: [withRange(transferV1, {firstBlock: 100, lastBlock: 400})] as unknown as Abi,
					address: A,
					startBlock: 100,
				},
				{
					abi: [withRange(transferV1, {firstBlock: 700, lastBlock: 900})] as unknown as Abi,
					address: B,
					startBlock: 100,
				},
			],
		};

		// no throw: these are two different contracts' lifetimes, not one hole
		const live = liveEventsOf(source);
		expect(live.length).toBe(2);
		expect(live.map((event) => event.address).sort()).toEqual([A, B].sort());
	});
});

describe('the source hashes an invalidation is computed on', () => {
	it('is byte-identical to today when the source declares no range at all', () => {
		// No existing deployment may change behaviour merely by upgrading, so a
		// source with no ranges must still hash to the one whole-source entry.
		const source = sourceOf([transferV1, approval]);

		expect(sourceHashesOf(source)).toEqual([{startBlock: 0, hash: simple_hash(source)}]);
	});

	it('is one entry per normalised range, ordered so an append lands at the END', () => {
		const source = sourceOf([withRange(transferV1, {firstBlock: 100}), withRange(approval, {firstBlock: 900})]);

		const hashes = sourceHashesOf(source);
		expect(hashes.map((entry) => entry.startBlock)).toEqual([0, 100, 900]);
	});

	it('leaves the existing entries untouched when an entry is appended above them', () => {
		const before = sourceHashesOf(sourceOf([withRange(transferV1, {firstBlock: 100})]));
		const after = sourceHashesOf(
			sourceOf([withRange(transferV1, {firstBlock: 100}), withRange(approval, {firstBlock: 900})]),
		);

		expect(after.slice(0, before.length)).toEqual(before);
	});

	it('is UNCHANGED by a redundant append that normalises away', () => {
		// `[A@a, B@b, A@c]`: the rollback entry vanishes, so the list must not shift.
		// `indexerMatches` compares element-wise BY INDEX, so a shift would re-index
		// the world for a generator that simply could not recognise a rollback.
		const twoEntries = sourceOf([withRange(transferV1, {firstBlock: 100}), withRange(transferV2, {firstBlock: 400})]);
		const withRollback = sourceOf([
			withRange(transferV1, {firstBlock: 100}),
			withRange(transferV2, {firstBlock: 400}),
			withRange(transferV1, {firstBlock: 700}),
		]);

		expect(sourceHashesOf(withRollback)).toEqual(sourceHashesOf(twoEntries));
	});

	it('moves the entry whose event definition was edited, and only that one', () => {
		const before = sourceHashesOf(
			sourceOf([withRange(transferV1, {firstBlock: 100}), withRange(approval, {firstBlock: 900})]),
		);
		const after = sourceHashesOf(
			sourceOf([withRange(transferV2, {firstBlock: 100}), withRange(approval, {firstBlock: 900})]),
		);

		expect(after[0]).toEqual(before[0]);
		expect(after[1]).not.toEqual(before[1]);
		expect(after[2]).toEqual(before[2]);
	});

	it('moves the entry at block 0 when something outside the ABI changed', () => {
		const before = sourceHashesOf(sourceOf([withRange(transferV1, {firstBlock: 100})], {address: A}));
		const after = sourceHashesOf(sourceOf([withRange(transferV1, {firstBlock: 100})], {address: B}));

		expect(after[0]).not.toEqual(before[0]);
	});
});

describe('the invalidation decision, which can name the block it starts at', () => {
	const CURSOR = 500;
	const base = sourceOf([withRange(transferV1, {firstBlock: 100})]);
	const stored = contextOf(sourceHashesOf(base));

	const decide = (source: IndexingSource<Abi>, context = stored, cursor = CURSOR) =>
		sourceInvalidationOf(sourceHashesOf(source), 'cfg', cursor, context);

	it('keeps everything when an entry is appended ABOVE the cursor', () => {
		const appended = sourceOf([withRange(transferV1, {firstBlock: 100}), withRange(approval, {firstBlock: 900})]);

		expect(decide(appended)).toEqual({valid: true});
		expect(indexerMatches(sourceHashesOf(appended), 'cfg', CURSOR, stored)).toBe(true);
	});

	it('invalidates from the appended block when the entry starts AT or BELOW the cursor', () => {
		const atCursor = sourceOf([withRange(transferV1, {firstBlock: 100}), withRange(approval, {firstBlock: CURSOR})]);
		const below = sourceOf([withRange(transferV1, {firstBlock: 100}), withRange(approval, {firstBlock: 400})]);

		expect(decide(atCursor)).toMatchObject({valid: false, invalidFromBlock: CURSOR});
		expect(decide(below)).toMatchObject({valid: false, invalidFromBlock: 400});
	});

	it('invalidates when an entry already below the cursor was EDITED, though the length did not change', () => {
		const edited = sourceOf([withRange(transferV1, {firstBlock: 100, lastBlock: 900})]);

		expect(decide(edited)).toMatchObject({valid: false, invalidFromBlock: 100});
	});

	it('invalidates when an entry below the cursor was REMOVED', () => {
		const twoEntries = sourceOf([withRange(transferV1, {firstBlock: 100}), withRange(approval, {firstBlock: 200})]);
		const removed = sourceOf([withRange(transferV1, {firstBlock: 100})]);

		expect(decide(removed, contextOf(sourceHashesOf(twoEntries)))).toMatchObject({valid: false, invalidFromBlock: 200});
	});

	it('keeps everything when a redundant entry is appended', () => {
		const withRollback = sourceOf([withRange(transferV1, {firstBlock: 100}), withRange(transferV1, {firstBlock: 900})]);

		expect(decide(withRollback)).toEqual({valid: true});
	});

	it('invalidates from block 0 when the stream config moved, whatever the ranges say', () => {
		expect(decide(base, contextOf(sourceHashesOf(base), 'other'))).toMatchObject({valid: false, invalidFromBlock: 0});
	});

	it('answers exactly as before for a source that declares no range', () => {
		const noRanges = sourceOf([transferV1]);
		const changed = sourceOf([transferV2]);
		const legacy = contextOf(sourceHashesOf(noRanges));

		expect(sourceInvalidationOf(sourceHashesOf(noRanges), 'cfg', CURSOR, legacy)).toEqual({valid: true});
		expect(sourceInvalidationOf(sourceHashesOf(changed), 'cfg', CURSOR, legacy)).toMatchObject({
			valid: false,
			invalidFromBlock: 0,
		});
	});
});
