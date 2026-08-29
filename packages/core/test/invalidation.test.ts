import type {Abi} from 'abitype';
import {describe, expect, it} from 'vitest';
import {sourceHashesOf} from '../src/internal/engine/eventRanges.js';
import {sourceInvalidationOf, stateMatches, streamMatches} from '../src/internal/engine/utils.js';
import {simple_hash} from '../src/utils/hash.js';
import type {ContextIdentifier, IndexingSource, SourceHashEntry} from '../src/types.js';

// ---------------------------------------------------------------------------
// INVALIDATION IS COMPUTED ON WHAT EACH THING ACTUALLY DEPENDS ON
// ---------------------------------------------------------------------------
// An ABI is REGENERATED, not hand-edited, so the things that move in it most
// often are the things no log depends on: an added view function, a reordered
// array, an `internalType` a second compilation spells differently. Hashing the
// whole source into one entry made every one of those cost a complete re-fetch
// of all history.
//
// And the fetch and the fold do not depend on the same thing. Raw logs are
// fetched under a topic-and-address filter, so they survive anything that did
// not GROW the topic set; the state is a fold over DECODED events, so it dies
// whenever the decoding shape moved. A renamed non-indexed parameter is the case
// that proves it: `topic0` hashes types and not names.
// ---------------------------------------------------------------------------

const A = '0x0000000000000000000000000000000000000001' as const;
const B = '0x0000000000000000000000000000000000000002' as const;

const START_BLOCK = 100;
const CURSOR = 500;

const transfer = {
	type: 'event',
	name: 'Transfer',
	anonymous: false,
	inputs: [
		{indexed: true, name: 'from', type: 'address'},
		{indexed: true, name: 'to', type: 'address'},
		{indexed: false, name: 'id', type: 'uint256'},
	],
} as const;

/** The SAME event with a non-indexed parameter renamed: same `topic0`, different decode. */
const transferRenamedParameter = {
	...transfer,
	inputs: [
		{indexed: true, name: 'from', type: 'address'},
		{indexed: true, name: 'to', type: 'address'},
		{indexed: false, name: 'tokenId', type: 'uint256'},
	],
} as const;

/** The same event as a second compilation spells it: `internalType` where there was none. */
const transferRecompiled = {
	...transfer,
	inputs: [
		{indexed: true, name: 'from', type: 'address', internalType: 'address'},
		{indexed: true, name: 'to', type: 'address', internalType: 'address'},
		{indexed: false, name: 'id', type: 'uint256', internalType: 'uint256'},
	],
} as const;

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

/** The members a regenerated ABI gains that no log can depend on. */
const balanceOf = {
	type: 'function',
	name: 'balanceOf',
	stateMutability: 'view',
	inputs: [{name: 'owner', type: 'address'}],
	outputs: [{name: '', type: 'uint256'}],
} as const;

const notOwner = {type: 'error', name: 'NotOwner', inputs: [{name: 'caller', type: 'address'}]} as const;

const constructor_ = {type: 'constructor', stateMutability: 'nonpayable', inputs: [{name: 'admin', type: 'address'}]};

function sourceOf(
	abi: readonly unknown[],
	options: {address?: `0x${string}`; startBlock?: number; chainId?: string} = {},
): IndexingSource<Abi> {
	return {
		chainId: options.chainId ?? '1',
		contracts: [
			{
				abi: abi as unknown as Abi,
				address: options.address ?? A,
				startBlock: options.startBlock ?? START_BLOCK,
			},
		],
	};
}

const contextOf = (hashes: SourceHashEntry[], config = 'cfg'): ContextIdentifier => ({
	source: hashes,
	config,
	processor: 'p',
});

/**
 * The entries as INVALIDATION reads them, which is every field but `legacyHash`.
 *
 * `legacyHash` is the migration bridge and is deliberately a digest of the WHOLE
 * source, so it is the one field that moves when a regenerated ABI gains a view
 * function. It has to: it exists to be compared against what the pre-per-event
 * code persisted, which committed to exactly those bytes. No verdict reads it
 * except through that bridge, which is pinned by its own test below.
 */
const identityOf = (source: IndexingSource<Abi>) =>
	sourceHashesOf(source).map(({startBlock, hash, streamHash}) => ({startBlock, hash, streamHash}));

/** The baseline every case below diverges from: one event, no declared range. */
const base = sourceOf([transfer]);
const stored = contextOf(sourceHashesOf(base));

const decide = (source: IndexingSource<Abi>, context = stored, cursor = CURSOR) =>
	sourceInvalidationOf(sourceHashesOf(source), 'cfg', cursor, context);

// ---------------------------------------------------------------------------

describe('an ABI member no log depends on', () => {
	it('hashes byte-identically when a view function is added', () => {
		expect(identityOf(sourceOf([transfer, balanceOf]))).toEqual(identityOf(base));
	});

	it('hashes byte-identically when an error or a constructor is added', () => {
		expect(identityOf(sourceOf([transfer, notOwner, constructor_]))).toEqual(identityOf(base));
	});

	it('invalidates NOTHING, on either half', () => {
		expect(decide(sourceOf([transfer, balanceOf, notOwner, constructor_]))).toEqual({
			state: {valid: true},
			stream: {valid: true},
		});
	});

	it('hashes byte-identically when the events are REORDERED', () => {
		// the list is sorted into a canonical order rather than transcribed from the
		// ABI array, which is what makes this true of the BYTES and not only of the
		// verdict
		expect(identityOf(sourceOf([approval, transfer]))).toEqual(identityOf(sourceOf([transfer, approval])));
	});

	it('hashes byte-identically when a recompilation spells `internalType` differently', () => {
		expect(identityOf(sourceOf([transferRecompiled]))).toEqual(identityOf(base));
	});

	it('carries the whole-source bridge on the block-0 entry and NOWHERE else', () => {
		const entries = sourceHashesOf(sourceOf([transfer, balanceOf]));

		expect(entries[0].legacyHash).toBe(simple_hash(sourceOf([transfer, balanceOf])));
		expect(entries.slice(1).every((entry) => entry.legacyHash === undefined)).toBe(true);
		// and it MOVES where the identity above does not, which is the whole reason it
		// is not part of the identity
		expect(entries[0].legacyHash).not.toBe(sourceHashesOf(base)[0].legacyHash);
	});
});

describe('a renamed NON-INDEXED parameter, which is the case that splits the verdict', () => {
	it('leaves the entry the FETCH depends on alone and moves the one the DECODE depends on', () => {
		const before = sourceHashesOf(base);
		const after = sourceHashesOf(sourceOf([transferRenamedParameter]));

		// `topic0` hashes types and not names, so the filter is the same filter
		expect(after[1].streamHash).toEqual(before[1].streamHash);
		expect(after[1].hash).not.toEqual(before[1].hash);
	});

	it('keeps the stream and discards the state', () => {
		const verdict = decide(sourceOf([transferRenamedParameter]));

		expect(verdict.stream).toEqual({valid: true});
		expect(verdict.state).toMatchObject({valid: false, invalidFromBlock: START_BLOCK});
	});

	it('says so through the two gates the indexer actually calls', () => {
		const hashes = sourceHashesOf(sourceOf([transferRenamedParameter]));

		expect(streamMatches(hashes, 'cfg', CURSOR, stored)).toBe(true);
		expect(stateMatches(hashes, 'cfg', CURSOR, stored)).toBe(false);
	});
});

describe('an event ADDED to a source that declares no range', () => {
	it('invalidates both halves, from the contract start block and no lower', () => {
		const verdict = decide(sourceOf([transfer, approval]));

		// the topic set GREW, so those blocks were fetched under a filter that was
		// missing a topic and nothing after the fact can tell
		expect(verdict.stream).toMatchObject({valid: false, invalidFromBlock: START_BLOCK, reason: 'entry-added'});
		expect(verdict.state).toMatchObject({valid: false, invalidFromBlock: START_BLOCK, reason: 'entry-added'});
	});

	it('costs nothing at all while the cursor is still below the contract start block', () => {
		expect(decide(sourceOf([transfer, approval]), stored, START_BLOCK - 1)).toEqual({
			state: {valid: true},
			stream: {valid: true},
		});
	});
});

describe('an event REMOVED from the ABI', () => {
	const twoEvents = sourceOf([transfer, approval]);
	const storedWithBoth = contextOf(sourceHashesOf(twoEvents));

	it('still discards the state derived from it', () => {
		expect(decide(base, storedWithBoth).state).toMatchObject({
			valid: false,
			invalidFromBlock: START_BLOCK,
			reason: 'entry-removed',
		});
	});

	it('keeps the stream, because a shrunken topic set leaves a SUPERSET', () => {
		expect(decide(base, storedWithBoth).stream).toEqual({valid: true});
	});
});

describe('the rest of the source, which is NOT free', () => {
	it('invalidates both halves from block 0 when the chain id moved', () => {
		const verdict = decide(sourceOf([transfer], {chainId: '137'}));

		expect(verdict.state).toMatchObject({valid: false, invalidFromBlock: 0});
		expect(verdict.stream).toMatchObject({valid: false, invalidFromBlock: 0});
	});

	it('invalidates both halves from block 0 when a contract address moved', () => {
		const verdict = decide(sourceOf([transfer], {address: B}));

		expect(verdict.state).toMatchObject({valid: false, invalidFromBlock: 0});
		expect(verdict.stream).toMatchObject({valid: false, invalidFromBlock: 0});
	});

	it('invalidates both halves from block 0 when a contract start block moved', () => {
		const verdict = decide(sourceOf([transfer], {startBlock: 50}));

		expect(verdict.state).toMatchObject({valid: false, invalidFromBlock: 0});
		expect(verdict.stream).toMatchObject({valid: false, invalidFromBlock: 0});
	});

	it('invalidates both halves from block 0 when the stream config moved', () => {
		const verdict = decide(base, contextOf(sourceHashesOf(base), 'other'));

		expect(verdict.state).toMatchObject({valid: false, invalidFromBlock: 0, reason: 'stream-config'});
		expect(verdict.stream).toMatchObject({valid: false, invalidFromBlock: 0, reason: 'stream-config'});
	});
});

// ---------------------------------------------------------------------------
// `ContextIdentifier` IS PERSISTED, so this is a stored-format change.
// ---------------------------------------------------------------------------
// A context written by the shipped code must not read as invalid: that would
// silently re-index every existing deployment on upgrade, which is the exact
// cost this change exists to remove.

/** What the shipped code persists for a source that declares NO range: one whole-source entry. */
const wholeSourceContextOf = (source: IndexingSource<Abi>, config = 'cfg'): ContextIdentifier =>
	contextOf([{startBlock: 0, hash: simple_hash(source)}], config);

/** What the shipped code persists for a source that DOES: the same list, without the new fields. */
const withoutTheNewFields = (source: IndexingSource<Abi>, config = 'cfg'): ContextIdentifier =>
	contextOf(
		sourceHashesOf(source).map((entry) => ({startBlock: entry.startBlock, hash: entry.hash})),
		config,
	);

const withRange = (event: object, range: {firstBlock?: number; lastBlock?: number}) => ({...event, ...range});

describe('a context persisted by the shipped code', () => {
	it('reads as valid when nothing about the source moved', () => {
		expect(decide(base, wholeSourceContextOf(base))).toEqual({state: {valid: true}, stream: {valid: true}});
	});

	it('reads as valid through a DIFFERENT source object carrying the same bytes', () => {
		expect(decide(sourceOf([transfer]), wholeSourceContextOf(sourceOf([transfer])))).toEqual({
			state: {valid: true},
			stream: {valid: true},
		});
	});

	it('re-indexes ONCE for a gained view function, because that is all the old entry committed to', () => {
		// The bridge can only compare what the shipped entry actually hashed, which
		// is the whole source. So the first load after the upgrade still pays for a
		// regenerated ABI -- and it is the last time it can, since that load rewrites
		// the context as the per-event list.
		const verdict = decide(sourceOf([transfer, balanceOf]), wholeSourceContextOf(base));

		expect(verdict.state).toMatchObject({valid: false, invalidFromBlock: 0});
		expect(verdict.stream).toMatchObject({valid: false, invalidFromBlock: 0});
	});

	it('still invalidates from block 0 when the source genuinely moved', () => {
		const verdict = decide(sourceOf([transfer, approval]), wholeSourceContextOf(base));

		expect(verdict.state).toMatchObject({valid: false, invalidFromBlock: 0});
		expect(verdict.stream).toMatchObject({valid: false, invalidFromBlock: 0});
	});

	it('reads a RANGED context as valid, because the per-event hashes did not move', () => {
		const ranged = sourceOf([withRange(transfer, {firstBlock: 100}), withRange(approval, {firstBlock: 900})]);

		expect(decide(ranged, withoutTheNewFields(ranged))).toEqual({state: {valid: true}, stream: {valid: true}});
	});

	it('falls back to the state verdict for the stream half, since the stored entries cannot answer', () => {
		// Conservative on purpose: a stored entry with no `streamHash` says nothing
		// about the filter it was fetched under, so the stream is judged exactly as
		// the state is until the first save rewrites it.
		const ranged = sourceOf([withRange(transfer, {firstBlock: 100}), withRange(approval, {firstBlock: 900})]);
		const shrunk = sourceOf([withRange(transfer, {firstBlock: 100})]);

		const verdict = decide(shrunk, withoutTheNewFields(ranged), 1000);
		expect(verdict.state).toMatchObject({valid: false, invalidFromBlock: 900});
		expect(verdict.stream).toEqual(verdict.state);
	});
});
