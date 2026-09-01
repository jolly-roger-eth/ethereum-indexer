import 'fake-indexeddb/auto';
import {BLOB_SNAPSHOT_FORMAT, taggedBnReplacer} from '@etherfold/core';
import {contextFilenames} from '@etherfold/utils/indexer';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {keepStateOnIndexedDB} from '../src/storage/state/OnIndexedDB.js';

// ---------------------------------------------------------------------------
// A published snapshot a client cannot read is REFUSED, not installed as state
// ---------------------------------------------------------------------------
// `keepStateOnIndexedDB`'s remote half downloads the file `@etherfold/cli`'s
// keeper publishes, and that file carries a format number precisely so a reader
// can tell the encodings apart. The CLI refuses a format-1 file locally and cold
// starts; until this suite, the browser read the same bytes without checking the
// number, and -- with no fallback reviver left (ADR-0029) -- every `uint256` in
// `lastSync.unconfirmedBlocks[].events[].args` arrived as the STRING `"123n"`.
// The client then indexed on top of silently mistyped state.
//
// Every assertion on what loads is on the TYPE, because that is the whole
// defect: the value survives a type swap and the test would pass with it.
// ---------------------------------------------------------------------------

const CONTEXT: any = {
	source: {chainId: '8453', contracts: [{abi: [], address: '0x01', startBlock: 0}]},
	config: undefined,
	version: 'v1',
};

const {stateFile, lastSyncFile} = contextFilenames(CONTEXT);

/** What a format-1 writer put on disk: BigInts suffixed with `n`, i.e. strings. */
function formatOneSnapshot(lastToBlock: number) {
	return JSON.stringify({
		format: 1,
		processor: 'p1',
		savedAt: '2024-01-01T00:00:00.000Z',
		lastSync: {
			lastFromBlock: 0,
			lastToBlock,
			latestBlock: lastToBlock,
			unconfirmedBlocks: [{number: lastToBlock, hash: '0xaa', events: [{args: {value: '123n', memo: '123n'}}]}],
		},
		state: {total: '123n', label: 'from-format-one'},
	});
}

/** What this build's writer puts on disk: BigInts tagged by the core codec. */
function formatTwoSnapshot(lastToBlock: number, label: string) {
	return JSON.stringify(
		{
			format: BLOB_SNAPSHOT_FORMAT,
			processor: 'p1',
			savedAt: '2025-01-01T00:00:00.000Z',
			lastSync: {
				lastFromBlock: 0,
				lastToBlock,
				latestBlock: lastToBlock,
				unconfirmedBlocks: [{number: lastToBlock, hash: '0xaa', events: [{args: {value: 123n, memo: '123n'}}]}],
			},
			state: {total: 2n ** 200n, label},
		},
		taggedBnReplacer,
	);
}

/** The bare `lastSync` file a prefix-form mirror publishes: NO envelope at all. */
function bareLastSync(lastToBlock: number) {
	return JSON.stringify({lastFromBlock: 0, lastToBlock, latestBlock: lastToBlock, unconfirmedBlocks: []});
}

/** A `fetch` that serves a fixed map of URL -> body, so a test's mirrors are real URLs. */
function fetchServing(bodies: Record<string, string>) {
	return vi.fn(async (url: string) => {
		if (!(url in bodies)) throw new Error(`unexpected fetch of ${url}`);
		return {text: async () => bodies[url]};
	});
}

/** Every TYPE assertion on what loaded, in one place: BigInts are BigInts. */
function expectBigIntTypesIntact(fetched: any) {
	const args = fetched.lastSync.unconfirmedBlocks[0].events[0].args;
	expect(args.value).toBe(123n);
	expect(typeof args.value).toBe('bigint');
	expect(args.memo).toBe('123n');
	expect(typeof args.memo).toBe('string');
	expect(fetched.state.total).toBe(2n ** 200n);
	expect(typeof fetched.state.total).toBe('bigint');
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('a snapshot this build cannot read is REFUSED, never installed', () => {
	it('refuses a format-1 payload offered as the only remote, so nothing loads at all', async () => {
		vi.stubGlobal('fetch', fetchServing({'https://mirror.example/state.json': formatOneSnapshot(10)}));
		const keeper = keepStateOnIndexedDB('refuse-single', {url: 'https://mirror.example/state.json'});
		await keeper.clear(CONTEXT);

		// the whole defect is that this used to return a state whose every
		// `uint256` had quietly become the string `"123n"`. Refusal is stronger
		// than returning it with the right types: nothing is installed.
		const fetched = await keeper.fetch(CONTEXT);
		expect(fetched).toBeUndefined();
	});

	it('logs the refusal with the location and BOTH numbers, rather than being silent about it', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.stubGlobal('fetch', fetchServing({'https://mirror.example/state.json': formatOneSnapshot(10)}));
		const keeper = keepStateOnIndexedDB('refuse-logged', {url: 'https://mirror.example/state.json'});
		await keeper.clear(CONTEXT);

		await keeper.fetch(CONTEXT);
		expect(error).toHaveBeenCalled();
		const messages = error.mock.calls.map((call) => call.join(' '));
		expect(
			messages.some(
				(message) =>
					message.includes('https://mirror.example/state.json') &&
					message.includes('format 1') &&
					message.includes(`reads ${BLOB_SNAPSHOT_FORMAT}`),
			),
			`the refusal must name where the unreadable snapshot came from and both numbers; got: ${messages.join(' | ')}`,
		).toBe(true);
	});

	it('refuses the bare pre-envelope form (no `format` at all) exactly as the CLI does', async () => {
		vi.stubGlobal(
			'fetch',
			fetchServing({
				'https://mirror.example/state.json': JSON.stringify({lastSync: {lastToBlock: 1}, state: {total: '123n'}}),
			}),
		);
		const keeper = keepStateOnIndexedDB('refuse-bare', {url: 'https://mirror.example/state.json'});
		await keeper.clear(CONTEXT);

		expect(await keeper.fetch(CONTEXT)).toBeUndefined();
	});
});

describe('an unreadable mirror fails over to a readable one', () => {
	it('never lets an unreadable mirror win selection when the location IS the snapshot', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		// the format-1 mirror claims to be AHEAD (1000 vs 900): selection must
		// refuse it on its format rather than on its position, so the readable
		// mirror wins even though it is behind.
		vi.stubGlobal(
			'fetch',
			fetchServing({
				'https://a.example/state.json': formatOneSnapshot(1000),
				'https://b.example/state.json': formatTwoSnapshot(900, 'from-b'),
			}),
		);
		const keeper = keepStateOnIndexedDB('failover-url', [
			{url: 'https://a.example/state.json'},
			{url: 'https://b.example/state.json'},
		]);
		await keeper.clear(CONTEXT);

		const fetched: any = await keeper.fetch(CONTEXT);
		expect(fetched.state.label).toBe('from-b');
		expectBigIntTypesIntact(fetched);
		expect(error.mock.calls.map((call) => call.join(' '))).toContainEqual(
			expect.stringContaining('https://a.example/state.json'),
		);
	});

	it('falls through a selected-but-unreadable payload to the next mirror, and that state is what loads', async () => {
		// prefix-form mirrors: selection compares the bare `lastSync` files, so
		// the format-1 mirror WINS selection (1000 vs 900) and is only refused
		// when its payload arrives. The failover must then serve the readable one.
		vi.stubGlobal(
			'fetch',
			fetchServing({
				[`https://a.example/${lastSyncFile}`]: bareLastSync(1000),
				[`https://a.example/${stateFile}`]: formatOneSnapshot(1000),
				[`https://b.example/${lastSyncFile}`]: bareLastSync(900),
				[`https://b.example/${stateFile}`]: formatTwoSnapshot(900, 'from-b'),
			}),
		);
		const keeper = keepStateOnIndexedDB('failover-prefix', [
			{prefix: 'https://a.example/'},
			{prefix: 'https://b.example/'},
		]);
		await keeper.clear(CONTEXT);

		const fetched: any = await keeper.fetch(CONTEXT);
		expect(fetched.state.label).toBe('from-b');
		expectBigIntTypesIntact(fetched);
	});
});

describe('local state that is already ahead still wins', () => {
	it('wins over a readable remote snapshot that is behind', async () => {
		vi.stubGlobal('fetch', fetchServing({'https://mirror.example/state.json': formatTwoSnapshot(90, 'from-remote')}));
		const keeper = keepStateOnIndexedDB('local-ahead', {url: 'https://mirror.example/state.json'});
		await keeper.clear(CONTEXT);
		await keeper.save(CONTEXT, {
			state: {label: 'from-local', total: 2n ** 200n},
			lastSync: {
				lastFromBlock: 0,
				lastToBlock: 100,
				latestBlock: 100,
				unconfirmedBlocks: [{number: 100, hash: '0xbb', events: [{args: {value: 123n, memo: '123n'}}]}],
			},
		} as any);

		const fetched: any = await keeper.fetch(CONTEXT);
		expect(fetched.state.label).toBe('from-local');
		expectBigIntTypesIntact(fetched);
	});

	it('wins over an unreadable remote snapshot, however far ahead that snapshot claims to be', async () => {
		vi.stubGlobal('fetch', fetchServing({'https://mirror.example/state.json': formatOneSnapshot(9000)}));
		const keeper = keepStateOnIndexedDB('local-ahead-unreadable', {url: 'https://mirror.example/state.json'});
		await keeper.clear(CONTEXT);
		await keeper.save(CONTEXT, {
			state: {label: 'from-local', total: 2n ** 200n},
			lastSync: {
				lastFromBlock: 0,
				lastToBlock: 100,
				latestBlock: 100,
				unconfirmedBlocks: [{number: 100, hash: '0xbb', events: [{args: {value: 123n, memo: '123n'}}]}],
			},
		} as any);

		const fetched: any = await keeper.fetch(CONTEXT);
		expect(fetched.state.label).toBe('from-local');
		expectBigIntTypesIntact(fetched);
	});
});

describe('the unversioned bare `lastSync` file', () => {
	// A prefix-form mirror's `lastSync` file carries NO format number -- the CLI
	// writes it bare beside the enveloped state file -- so a versioned reader has
	// to decide what it means. The recorded decision: it is SELECTION data only.
	// The one field used from it is `lastToBlock`, a plain number identical under
	// every encoding of the envelope, and nothing from it is ever installed: the
	// file that IS installed is the state file, which carries the format check.
	// Refusing the head instead would make every mirror the CLI publishes
	// unselectable, putting the guard where the damage is not.
	it('is read as selection data: it orders the mirrors and nothing from it is installed', async () => {
		vi.stubGlobal(
			'fetch',
			fetchServing({
				[`https://mirror.example/${lastSyncFile}`]: bareLastSync(50),
				[`https://mirror.example/${stateFile}`]: formatTwoSnapshot(50, 'from-payload'),
			}),
		);
		const keeper = keepStateOnIndexedDB('bare-head', {prefix: 'https://mirror.example/'});
		await keeper.clear(CONTEXT);

		const fetched: any = await keeper.fetch(CONTEXT);
		expect(fetched.state.label).toBe('from-payload');
		expect(fetched.lastSync.lastToBlock).toBe(50);
		expectBigIntTypesIntact(fetched);
	});

	it('cannot smuggle an unreadable payload past selection: the head says where, the payload says whether', async () => {
		vi.stubGlobal(
			'fetch',
			fetchServing({
				[`https://mirror.example/${lastSyncFile}`]: bareLastSync(50),
				[`https://mirror.example/${stateFile}`]: formatOneSnapshot(50),
			}),
		);
		const keeper = keepStateOnIndexedDB('bare-head-unreadable', {prefix: 'https://mirror.example/'});
		await keeper.clear(CONTEXT);

		// the head was read (it is selection data), the payload was refused (it
		// is what would have been installed), so the client cold starts.
		expect(await keeper.fetch(CONTEXT)).toBeUndefined();
	});
});
