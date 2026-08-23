import {describe, expect, it, vi} from 'vitest';
import {
	BlockNotRetainedError,
	BlockUnavailableError,
	MemoryStateStore,
	assertRetained,
	resolveRetention,
	retainedRange,
	retentionWithoutPruning,
	type Retention,
	type StateStoreCapabilities,
} from '../src/index.js';
import {TOKEN} from './utils/fixtures.js';

/**
 * Retention is a number a deployment SETS and a store REPORTS, and the refusal
 * is what makes the report worth reading.
 *
 * The unit is BLOCK NUMBERS and there is only one unit. The trap that makes that
 * worth testing rather than merely stating: on the real measured stream
 * event-bearing blocks are median 429 apart, so a window of 64 BLOCKS holds
 * exactly one event-bearing block. A window is not a number of updates, and it
 * is not a duration.
 *
 * These are the rules themselves: the setting a deployment writes, the range it
 * resolves to, and the refusal a store raises. That a STORE honours its own
 * claim -- answers inside its window, refuses outside it, refuses everything
 * when it keeps history for revert alone -- is asserted against every backend by
 * the shared suite (`@etherfold/state-store-conformance`), which runs this
 * package's `MemoryStateStore` under each of the three claims.
 */

const capabilities = (retention: Retention, asOf = retention.kind !== 'revert-only'): StateStoreCapabilities => ({
	retention,
	asOf,
});

describe('a deployment sets retention, in block numbers', () => {
	it('keeps everything when nothing is set', () => {
		// The default is the only one that claims nothing: no shipped store prunes,
		// so `unbounded` is what is TRUE of them, and a default window would be a
		// claim nothing enforces (and, at 64 blocks, nearly empty on a real stream).
		expect(resolveRetention(undefined, {})).toEqual({kind: 'unbounded'});
	});

	it('reads the three settings a deployment may write', () => {
		expect(resolveRetention('unbounded', {})).toEqual({kind: 'unbounded'});
		expect(resolveRetention('revert-only', {})).toEqual({kind: 'revert-only'});
		expect(resolveRetention({blocks: 128}, {finalityDepth: 64})).toEqual({kind: 'window', blocks: 128});
	});

	it('carries no unit but blocks', () => {
		// no `seconds`, no `updates`, nothing that would need a second enforcement path
		expect(Object.keys(resolveRetention({blocks: 128}, {finalityDepth: 64}))).toEqual(['kind', 'blocks']);
	});

	it('rejects a window below the finality depth, naming both numbers', () => {
		// reorg revert already reopens versions closed after the fork point, so the
		// finality depth is the floor retention cannot go under.
		expect(() => resolveRetention({blocks: 32}, {finalityDepth: 64})).toThrow(/32[\s\S]*64|64[\s\S]*32/);
		expect(() => resolveRetention({blocks: 32}, {finalityDepth: 64})).toThrow(/finality/i);
	});

	it('accepts a window exactly at the floor', () => {
		expect(resolveRetention({blocks: 64}, {finalityDepth: 64})).toEqual({kind: 'window', blocks: 64});
	});

	it('refuses a window that states no finality depth to protect', () => {
		expect(() => resolveRetention({blocks: 64}, {})).toThrow(/finality/i);
	});

	it('refuses every duration, on every spelling', () => {
		// Time prunes on WALL-CLOCK progress rather than chain progress: a stalled
		// indexer would drop history it never finished writing, and a halted chain
		// would expire its whole window while the tip stands still.
		for (const setting of ['1h', '7d', {seconds: 3600}, {ms: 60_000}, {days: 7}, {duration: '1h'}]) {
			expect(() => resolveRetention(setting as never, {finalityDepth: 64}), JSON.stringify(setting)).toThrow(/block/i);
		}
	});

	it('refuses a count of updates, which is not a distance in blocks', () => {
		expect(() => resolveRetention({updates: 100} as never, {finalityDepth: 64})).toThrow(/block/i);
	});

	it('refuses a bare number, because a bare number names no unit', () => {
		expect(() => resolveRetention(128 as never, {finalityDepth: 64})).toThrow(/blocks/i);
	});

	it('refuses a window that is not a whole number of blocks', () => {
		expect(() => resolveRetention({blocks: 1.5}, {finalityDepth: 0})).toThrow(/integer/i);
		expect(() => resolveRetention({blocks: -1}, {finalityDepth: 0})).toThrow(/integer|negative/i);
		expect(() => resolveRetention({blocks: '64'} as never, {finalityDepth: 0})).toThrow(/integer/i);
	});
});

describe('the retained range', () => {
	it('is a distance in block numbers behind the tip', () => {
		expect(retainedRange({kind: 'window', blocks: 60}, 1_000)).toEqual({from: 940, to: 1_000});
	});

	it('never runs below the first block', () => {
		expect(retainedRange({kind: 'window', blocks: 60}, 10)).toEqual({from: 0, to: 10});
	});

	it('is everything for an unbounded store, and nothing for a revert-only one', () => {
		expect(retainedRange({kind: 'unbounded'}, 1_000)).toEqual({from: 0, to: 1_000});
		expect(retainedRange({kind: 'revert-only'}, 1_000)).toBeUndefined();
	});
});

describe('a store that cannot prune reports what it actually keeps', () => {
	it('turns a window it cannot enforce into `unbounded`, which is what is true of it', () => {
		expect(retentionWithoutPruning({kind: 'window', blocks: 128})).toEqual({kind: 'unbounded'});
	});

	it('leaves the two it can honour alone', () => {
		expect(retentionWithoutPruning({kind: 'unbounded'})).toEqual({kind: 'unbounded'});
		expect(retentionWithoutPruning({kind: 'revert-only'})).toEqual({kind: 'revert-only'});
	});
});

describe('the refusal', () => {
	it('names what was asked and what is kept', async () => {
		const error = await assertRetained(capabilities({kind: 'window', blocks: 60}), 100, () => 1_000).catch((e) => e);

		expect(error).toBeInstanceOf(BlockNotRetainedError);
		expect(error.requested).toBe(100);
		expect(error.retained).toEqual({from: 940, to: 1_000});
		expect(error.reason).toBe('outside-window');
		expect(error.message).toMatch(/100/);
		expect(error.message).toMatch(/940/);
	});

	it('joins the `NoSuchBlockError` family rather than starting a new one', async () => {
		// ADR-0015 settled that a block a store cannot answer about is an ERROR and
		// not an empty result. "Not retained" is the same news as "no such block" to
		// a caller: it must not arrive wearing "entity absent" as a disguise.
		const error = await assertRetained(capabilities({kind: 'revert-only'}), 100, () => 1_000).catch((e) => e);
		expect(error).toBeInstanceOf(BlockUnavailableError);
		expect(error).toBeInstanceOf(Error);
	});

	it('says a revert-only store answers no historical read at all', async () => {
		const error = await assertRetained(capabilities({kind: 'revert-only'}), 999, () => 1_000).catch((e) => e);
		expect(error).toBeInstanceOf(BlockNotRetainedError);
		expect(error.reason).toBe('no-historical-reads');
		expect(error.retained).toBeUndefined();
	});

	it('refuses a store that keeps versions but answers no as-of read', async () => {
		const error = await assertRetained(capabilities({kind: 'unbounded'}, false), 10, () => 1_000).catch((e) => e);
		expect(error).toBeInstanceOf(BlockNotRetainedError);
		expect(error.reason).toBe('no-historical-reads');
	});

	it('lets a read inside the window through', async () => {
		await expect(assertRetained(capabilities({kind: 'window', blocks: 60}), 940, () => 1_000)).resolves.toBeUndefined();
	});

	it('never asks an unbounded store for its tip', async () => {
		const tip = vi.fn(() => 1_000);
		await assertRetained(capabilities({kind: 'unbounded'}), 1, tip);
		expect(tip).not.toHaveBeenCalled();
	});

	it('never asks a revert-only store for its tip either', async () => {
		const tip = vi.fn(() => 1_000);
		await expect(assertRetained(capabilities({kind: 'revert-only'}), 1, tip)).rejects.toBeInstanceOf(
			BlockNotRetainedError,
		);
		expect(tip).not.toHaveBeenCalled();
	});

	it('has no window to be outside of before the first block is applied', async () => {
		await expect(
			assertRetained(capabilities({kind: 'window', blocks: 60}), 1, () => undefined),
		).resolves.toBeUndefined();
	});
});

describe('a store keeps whatever it was set to, but claims only what it enforces', () => {
	it('reports `revert-only`, and reports that it answers no as-of read', () => {
		const store = new MemoryStateStore([TOKEN], {retention: 'revert-only'});
		expect(store.capabilities).toEqual({retention: {kind: 'revert-only'}, asOf: false});
	});

	it('accepts a window and still reports `unbounded` while nothing prunes', () => {
		const store = new MemoryStateStore([TOKEN], {retention: {blocks: 128}, finalityDepth: 64});
		expect(store.capabilities).toEqual({retention: {kind: 'unbounded'}, asOf: true});
	});

	it('rejects a window below the finality depth at construction, before any read', () => {
		expect(() => new MemoryStateStore([TOKEN], {retention: {blocks: 32}, finalityDepth: 64})).toThrow(/finality/i);
	});
});
