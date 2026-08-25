import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createFileKeepState, filepaths, SNAPSHOT_FORMAT} from '../src/keepState.js';

// Minimal ProcessorContext for filename derivation (contextFilenames hashes source/config/version).
const CONTEXT: any = {
	source: {
		chainId: '1',
		contracts: [{abi: [], address: '0x0000000000000000000000000000000000000001', startBlock: 0}],
	},
};

function makeAll(overrides?: any) {
	return {
		lastSync: {lastToBlock: 10, latestBlock: 10, lastFromBlock: 0, unconfirmedBlocks: [], context: {}},
		state: {count: 3, big: 123n},
		history: {h: 1},
		...overrides,
	};
}

let folder: string;
beforeEach(() => {
	folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ei-cli-keepstate-'));
});
afterEach(() => {
	vi.restoreAllMocks();
	fs.rmSync(folder, {recursive: true, force: true});
});

// ---------------------------------------------------------------------------
// Characterization tests (CURRENT behaviour — these should PASS as-is)
// ---------------------------------------------------------------------------

describe('createFileKeepState — characterization (current behaviour)', () => {
	it('round-trips state via save then fetch (incl. BigInt)', async () => {
		const ks = createFileKeepState(folder);
		const all = makeAll();
		await ks.save(CONTEXT, all as any);

		const fetched = await ks.fetch(CONTEXT);
		expect(fetched.state).toEqual({count: 3, big: 123n});
		expect(fetched.lastSync).toEqual(all.lastSync);
		expect(fetched.history).toEqual(all.history);
	});

	it('creates the folder if it does not exist', async () => {
		const nested = path.join(folder, 'a', 'b');
		const ks = createFileKeepState(nested);
		await ks.save(CONTEXT, makeAll() as any);
		const {stateFile} = filepaths(nested, CONTEXT);
		expect(fs.existsSync(stateFile)).toBe(true);
	});

	it('returns undefined from fetch when no snapshot file exists', async () => {
		const ks = createFileKeepState(folder);
		const fetched = await ks.fetch(CONTEXT);
		expect(fetched).toBeUndefined();
	});

	it('writes both the state file and the lastSync file', async () => {
		const ks = createFileKeepState(folder);
		await ks.save(CONTEXT, makeAll() as any);
		const {stateFile, lastSyncFile} = filepaths(folder, CONTEXT);
		expect(fs.existsSync(stateFile)).toBe(true);
		expect(fs.existsSync(lastSyncFile)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// HIGH-2 / MEDIUM-3: snapshot envelope (format/version) + don't silently
// swallow corrupt files. Backward-compatible: legacy bare snapshots still read.
// ---------------------------------------------------------------------------

describe('createFileKeepState — snapshot envelope (HIGH-2)', () => {
	it('writes an envelope with a format version and the processor hash', async () => {
		const ks = createFileKeepState(folder);
		const all = makeAll({
			lastSync: {
				lastToBlock: 10,
				latestBlock: 10,
				lastFromBlock: 0,
				unconfirmedBlocks: [],
				context: {source: [], config: 'c', processor: 'hash-abc'},
			},
		});
		await ks.save(CONTEXT, all as any);

		const {stateFile} = filepaths(folder, CONTEXT);
		const raw = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
		expect(raw.format).toBe(SNAPSHOT_FORMAT);
		expect(raw.processor).toBe('hash-abc');
		expect(typeof raw.savedAt).toBe('string');
		// and it still round-trips
		const fetched = await ks.fetch(CONTEXT);
		expect(fetched.state).toEqual(all.state);
	});

	it('REFUSES a snapshot written under an older format, rather than half-decoding it', async () => {
		// Format 1 (and the bare pre-envelope form) wrote BigInts as `"123n"`, which
		// this reader does not interpret. Accepting such a file would resume from a
		// state whose every `uint256` had quietly become a string, which is worse than
		// not resuming: the recovery from an unreadable snapshot is a cold start, and
		// that is what an unrecognised format gets.
		const {stateFile} = filepaths(folder, CONTEXT);
		fs.mkdirSync(folder, {recursive: true});
		const ks = createFileKeepState(folder);

		for (const legacy of [
			// the bare pre-envelope form: no `format` at all
			{lastSync: {lastToBlock: 1}, state: {count: 9, big: '123n'}, history: {h: 2}},
			// the enveloped format-1 form
			{format: 1, lastSync: {lastToBlock: 1}, state: {count: 9, big: '123n'}, history: {h: 2}},
		]) {
			fs.writeFileSync(stateFile, JSON.stringify(legacy));
			expect(await ks.fetch(CONTEXT)).toBeUndefined();
		}
	});

	it('round-trips real BigInts and look-alike strings in ONE snapshot, types intact', async () => {
		// The pairing the `"123n"` convention could not survive: `unconfirmedBlocks`
		// carries decoded events whose args hold a BigInt per `uint256`, and the SAME
		// document carries `context` digests and whatever strings the contract
		// emitted. Every assertion here is on the TYPE, because the old convention
		// passed on value while swapping one kind for the other.
		const ks = createFileKeepState(folder);
		const all = {
			lastSync: {
				lastToBlock: 10,
				latestBlock: 10,
				lastFromBlock: 0,
				context: {source: [{startBlock: 0, hash: 'h1x9tbhn'}], config: '123n', processor: 'h8918n'},
				unconfirmedBlocks: [
					{
						number: 10,
						hash: '0xaa',
						events: [{args: {value: 123n, memo: '123n', zero: 0n, zeroish: '0n', neg: -5n, negish: '-5n'}}],
					},
				],
			},
			state: {total: 2n ** 200n, label: '0n'},
			history: {h: 1},
		};
		await ks.save(CONTEXT, all as any);

		const fetched: any = await ks.fetch(CONTEXT);
		const args = fetched.lastSync.unconfirmedBlocks[0].events[0].args;
		expect(args.value).toBe(123n);
		expect(typeof args.value).toBe('bigint');
		expect(args.memo).toBe('123n');
		expect(typeof args.memo).toBe('string');
		expect(args.zero).toBe(0n);
		expect(typeof args.zeroish).toBe('string');
		expect(args.neg).toBe(-5n);
		expect(typeof args.negish).toBe('string');
		expect(fetched.state.total).toBe(2n ** 200n);
		expect(typeof fetched.state.label).toBe('string');
		expect(fetched.lastSync.context.config).toBe('123n');
		expect(typeof fetched.lastSync.context.config).toBe('string');

		// and the bytes on disk say WHICH is which, rather than rendering both the
		// same way and leaving the reader to guess
		const {stateFile, lastSyncFile} = filepaths(folder, CONTEXT);
		for (const file of [stateFile, lastSyncFile]) {
			const raw = fs.readFileSync(file, 'utf-8').replace(/\s+/g, '');
			expect(raw).toContain('"value":{"__bigint__":"123"}');
			expect(raw).toContain('"memo":"123n"');
			expect(raw).not.toContain('"value":"123n"');
		}
	});

	it('returns undefined (does not throw) for a present-but-corrupt snapshot', async () => {
		const {stateFile} = filepaths(folder, CONTEXT);
		fs.mkdirSync(folder, {recursive: true});
		fs.writeFileSync(stateFile, '{ this is not valid json');
		const ks = createFileKeepState(folder);
		const fetched = await ks.fetch(CONTEXT);
		expect(fetched).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Failing test demonstrating HIGH-1: the state file is written in place
// (writeFileSync directly over the destination). If the process is interrupted
// mid-write, the destination is left truncated / invalid JSON — which CI could
// commit and publish.
//
// We simulate an interruption by making the underlying write of the state file
// fail PART-WAY (after some bytes have already landed on the destination path).
// With an atomic implementation (temp file + rename) the previous/destination
// file is never observed in a corrupt state.
// ---------------------------------------------------------------------------

describe('createFileKeepState — HIGH-1 (atomic write)', () => {
	it('leaves the previous valid snapshot intact if a later save is interrupted mid-write', async () => {
		const ks = createFileKeepState(folder);
		const {stateFile} = filepaths(folder, CONTEXT);

		// First successful save -> a valid snapshot on disk.
		await ks.save(CONTEXT, makeAll({state: {count: 1}}) as any);
		const firstContent = fs.readFileSync(stateFile, 'utf-8');
		expect(JSON.parse(firstContent).state).toEqual({count: 1});

		// Now simulate a crash during the NEXT save's finalization: the (temp) write succeeds but the
		// step that publishes it onto the destination is interrupted. An atomic implementation must
		// leave the destination untouched (temp + rename); a naive in-place implementation would have
		// already truncated/overwritten the destination by this point.
		const realRenameSync = fs.renameSync.bind(fs);
		const spy = vi.spyOn(fs, 'renameSync').mockImplementation(((from: any, to: any, ...rest: any[]) => {
			if (typeof to === 'string' && to === stateFile) {
				throw new Error('simulated interruption (killed before rename completed)');
			}
			return (realRenameSync as any)(from, to, ...rest);
		}) as any);

		await expect(ks.save(CONTEXT, makeAll({state: {count: 2}}) as any)).rejects.toThrow();
		spy.mockRestore();

		// The destination must NOT be left corrupt: it should still be valid JSON,
		// and still the previous good snapshot (count:1), not a truncated mess.
		const afterContent = fs.readFileSync(stateFile, 'utf-8');
		expect(() => JSON.parse(afterContent)).not.toThrow();
		expect(JSON.parse(afterContent).state).toEqual({count: 1});

		// And no orphaned temp files should be left behind.
		const leftoverTmp = fs.readdirSync(folder).filter((f) => f.endsWith('.tmp'));
		expect(leftoverTmp).toEqual([]);
	});

	it('a successful subsequent save atomically replaces the snapshot (and leaves no temp files)', async () => {
		const ks = createFileKeepState(folder);
		const {stateFile} = filepaths(folder, CONTEXT);

		await ks.save(CONTEXT, makeAll({state: {count: 1}}) as any);
		await ks.save(CONTEXT, makeAll({state: {count: 2}}) as any);

		expect(JSON.parse(fs.readFileSync(stateFile, 'utf-8')).state).toEqual({count: 2});
		expect((await ks.fetch(CONTEXT)).state).toEqual({count: 2});
		expect(fs.readdirSync(folder).filter((f) => f.endsWith('.tmp'))).toEqual([]);
	});
});
