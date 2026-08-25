import 'fake-indexeddb/auto';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {keepStateOnIndexedDB} from '../src/storage/state/OnIndexedDB.js';
import {keepStateOnLocalStorage} from '../src/storage/state/OnLocalStorage.js';

// ---------------------------------------------------------------------------
// Both browser keepers, asserted on TYPE rather than on value
// ---------------------------------------------------------------------------
// A persisted `LastSync` carries both kinds at once: `unconfirmedBlocks` holds
// decoded `LogEvent`s whose `args` have a BigInt per `uint256`, and the same
// document holds `context` digests and whatever strings the contract emitted.
// The `"123n"` convention these used to share rendered `123n` and the string
// `"123n"` identically, so every value-only assertion passed while the type was
// silently swapped. These assert the type.
// ---------------------------------------------------------------------------

const CONTEXT: any = {
	source: {chainId: '8453', contracts: [{abi: [], address: '0x01', startBlock: 0}]},
	config: undefined,
	version: 'v1',
};

function payload() {
	return {
		state: {total: 2n ** 200n, label: '0n'},
		lastSync: {
			lastFromBlock: 0,
			lastToBlock: 10,
			latestBlock: 10,
			context: {source: [{startBlock: 0, hash: 'h1x9tbhn'}], config: '123n', processor: 'h8918n'},
			unconfirmedBlocks: [
				{
					number: 10,
					hash: '0xaa',
					events: [{args: {value: 123n, memo: '123n', zero: 0n, zeroish: '0n', neg: -5n, negish: '-5n'}}],
				},
			],
		},
	};
}

function expectTypesIntact(fetched: any) {
	const args = fetched.lastSync.unconfirmedBlocks[0].events[0].args;
	expect(args.value).toBe(123n);
	expect(typeof args.value).toBe('bigint');
	expect(args.memo).toBe('123n');
	expect(typeof args.memo).toBe('string');
	expect(args.zero).toBe(0n);
	expect(typeof args.zero).toBe('bigint');
	expect(args.zeroish).toBe('0n');
	expect(typeof args.zeroish).toBe('string');
	expect(args.neg).toBe(-5n);
	expect(typeof args.neg).toBe('bigint');
	expect(args.negish).toBe('-5n');
	expect(typeof args.negish).toBe('string');
	expect(fetched.state.total).toBe(2n ** 200n);
	expect(fetched.state.label).toBe('0n');
	expect(typeof fetched.state.label).toBe('string');
	expect(fetched.lastSync.context.config).toBe('123n');
	expect(typeof fetched.lastSync.context.config).toBe('string');
}

// A localStorage that is just a Map, which is all this keeper asks of it.
function installLocalStorage(): Map<string, string> {
	const store = new Map<string, string>();
	(globalThis as any).localStorage = {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
	};
	return store;
}

describe('keepStateOnLocalStorage', () => {
	let store: Map<string, string>;
	beforeEach(() => {
		store = installLocalStorage();
	});
	afterEach(() => {
		delete (globalThis as any).localStorage;
	});

	it('round-trips real BigInts and look-alike strings in one document, types intact', async () => {
		const keeper = keepStateOnLocalStorage('state');
		await keeper.save(CONTEXT, payload() as any);
		expectTypesIntact(await keeper.fetch(CONTEXT));
	});

	it('writes the tag, and writes a look-alike string as itself', async () => {
		const keeper = keepStateOnLocalStorage('state');
		await keeper.save(CONTEXT, payload() as any);

		const raw = [...store.values()][0];
		expect(raw).toContain('"value":{"__bigint__":"123"}');
		expect(raw).toContain('"memo":"123n"');
		expect(raw).not.toContain('"value":"123n"');
	});

	it('leaves a legacy `"123n"` blob as strings rather than guessing at it', async () => {
		// The recorded decision: the suffix form is not read at all. localStorage
		// carries no format number to refuse on, and it is a cache whose recovery is
		// a re-index, so a stale blob reads back as the strings it now is.
		const keeper = keepStateOnLocalStorage('state');
		await keeper.save(CONTEXT, payload() as any);
		const key = [...store.keys()][0];
		store.set(key, JSON.stringify({state: {total: '123n'}, lastSync: {lastToBlock: 1}}));

		const fetched: any = await keeper.fetch(CONTEXT);
		expect(fetched.state.total).toBe('123n');
		expect(typeof fetched.state.total).toBe('string');
	});
});

describe('keepStateOnIndexedDB', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('round-trips real BigInts and look-alike strings, types intact', async () => {
		// The local half never encodes: IndexedDB's structured clone stores a BigInt
		// as a BigInt. Asserted anyway, because the claim this keeper makes is about
		// what comes BACK, whatever the mechanism underneath.
		const keeper = keepStateOnIndexedDB('state-local');
		await keeper.save(CONTEXT, payload() as any);
		expectTypesIntact(await keeper.fetch(CONTEXT));
		await keeper.clear(CONTEXT);
	});

	it('round-trips them through a REMOTE snapshot too, which is where a codec is needed', async () => {
		// The remote half reads JSON over HTTP (a snapshot published by the CLI's
		// keeper), so it is the half that crosses a text boundary and needs a
		// convention. Encode it the way that keeper does and read it back.
		const {taggedBnReplacer} = await import('@etherfold/core');
		const body = JSON.stringify(payload(), taggedBnReplacer);
		expect(body).toContain('"value":{"__bigint__":"123"}');
		expect(body).toContain('"memo":"123n"');

		vi.stubGlobal('fetch', async () => ({text: async () => body}));
		const keeper = keepStateOnIndexedDB('state-remote', {url: 'https://example.invalid/state.json'});
		await keeper.clear(CONTEXT);

		expectTypesIntact(await keeper.fetch(CONTEXT));
	});

	it('does not revive a legacy `"123n"` remote snapshot into BigInts', async () => {
		const body = JSON.stringify({state: {total: '123n'}, lastSync: {lastToBlock: 1}});
		vi.stubGlobal('fetch', async () => ({text: async () => body}));
		const keeper = keepStateOnIndexedDB('state-legacy', {url: 'https://example.invalid/state.json'});
		await keeper.clear(CONTEXT);

		const fetched: any = await keeper.fetch(CONTEXT);
		expect(fetched.state.total).toBe('123n');
		expect(typeof fetched.state.total).toBe('string');
	});
});
