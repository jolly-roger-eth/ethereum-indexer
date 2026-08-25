import {describe, expect, it} from 'vitest';
import type {Abi} from 'abitype';
import {EthereumIndexer, simple_hash, taggedBnReplacer, taggedBnReviver} from '@etherfold/core';
import type {AllData, IndexingSource, KeepState, LastSync, LogEvent, ProcessorDriftReport} from '@etherfold/core';
import {fromJSProcessor, type JSProcessor} from '../src/processor/utils.js';
import {JSObjectEventProcessor} from '../src/processor/JSObjectEventProcessor.js';
import type {HistoryJSObject} from '../src/processor/history.js';

// ---------------------------------------------------------------------------
// A PROCESSOR'S VERSION HASH CANNOT SILENTLY LIE
// ---------------------------------------------------------------------------
// Two failure modes, both silent, both about the same thing: `getVersionHash()`
// is what stands between a logic change and state computed by the PREVIOUS logic
// being served forever.
//
//   1. The author never sets `version` -> the hash was a constant containing
//      `unknown`, so no logic change ever invalidated anything. Now it cannot be
//      constructed at all.
//   2. The author edits a handler and forgets to bump `version` -> the hash is
//      unchanged and correct-looking. The code FINGERPRINT is the second opinion,
//      compared by the core on load and reported, loudly, without halting.
// ---------------------------------------------------------------------------

const abi = [
	{
		type: 'event',
		name: 'Transfer',
		anonymous: false,
		inputs: [
			{indexed: true, name: 'from', type: 'address'},
			{indexed: true, name: 'to', type: 'address'},
			{indexed: false, name: 'id', type: 'uint256'},
		],
	},
] as const satisfies Abi;

type State = {owners: {[id: string]: string}; transferCount: number};

// Every processor VARIANT below is annotated `JSProcessor<typeof abi, State>`,
// spelled out rather than aliased. `EventFunctions` MAPS over the ABI's event
// names, so `ABI` is not inferrable from an object LITERAL: a bare spread of
// `processor` widens to the `Abi` constraint and the handlers it just copied
// stop matching the resulting index signature. The annotation also has to be
// this exact type REFERENCE, because that is what `fromJSProcessor` recovers
// `ABI` from; a local alias for it erases the type arguments again.

const processor: JSProcessor<typeof abi, State> = {
	version: '1.0.0',
	construct() {
		return {owners: {}, transferCount: 0};
	},
	onTransfer(state, event) {
		state.owners[event.args.id.toString()] = event.args.to;
		state.transferCount++;
	},
};

describe('a version is mandatory', () => {
	it('refuses to construct a processor with no version', () => {
		const {version, ...noVersion} = processor;
		expect(() => fromJSProcessor(noVersion as JSProcessor<typeof abi, State>)()).toThrow(/has no `version`/);
	});

	it('refuses an empty or whitespace-only version', () => {
		const empty: JSProcessor<typeof abi, State> = {...processor, version: ''};
		const whitespace: JSProcessor<typeof abi, State> = {...processor, version: '   '};
		expect(() => fromJSProcessor(empty)()).toThrow(/has no `version`/);
		expect(() => fromJSProcessor(whitespace)()).toThrow(/has no `version`/);
	});

	it('names the processor and says why the version is required', () => {
		// A `JSProcessor` is a plain object with no name of its own and an app can
		// have several, so the message names it by its handlers. An error that says
		// only "version required" leaves the author grepping.
		const {version, ...noVersion} = processor;
		let message = '';
		try {
			fromJSProcessor(noVersion as JSProcessor<typeof abi, State>)();
		} catch (err) {
			message = (err as Error).message;
		}
		expect(message).toContain('onTransfer');
		expect(message).toContain('construct');
		expect(message).toMatch(/discards\s+state|reused forever/);
	});

	it('refuses at the JSObjectEventProcessor seam too, not only via fromJSProcessor', () => {
		// `JSObjectEventProcessor` is exported and can be constructed with a custom
		// `SingleEventJSONProcessor`, which would otherwise walk straight past the
		// check in `fromJSProcessor`.
		const singleEventProcessor = {
			version: '',
			createInitialState: () => ({owners: {}, transferCount: 0}),
			configure: () => {},
			processEvent: () => {},
		};
		expect(() => new JSObjectEventProcessor(singleEventProcessor as any)).toThrow(/has no `version`/);
	});
});

describe('getVersionHash', () => {
	it('cannot contain the `unknown` fallback, because there is no fallback left', () => {
		const p = fromJSProcessor(processor)();
		expect(p.getVersionHash()).not.toContain('unknown');
		expect(p.getVersionHash()).toContain('1.0.0');
	});

	it('has no `unknown` branch left even with the constructor guard defeated', () => {
		// The criterion is that the fallback is REMOVED, not merely unreachable. A
		// constructor guard makes it unobservable through the front door, so this goes
		// through the back one: an unreachable `|| 'unknown'` would still be sitting in
		// the expression, one refactor away from being reachable again, and it is the
		// SHARED constant that is the bug (every version-less processor hashing alike).
		const p = fromJSProcessor(processor)();
		(p as unknown as {version: string | undefined}).version = undefined;
		expect(p.getVersionHash()).not.toContain('unknown');
	});

	it('carries no fallback constant at all, configured or not', () => {
		// Not just `unknown`: `not-configured` is gone too. The config half is hashed
		// the same way in both cases, so there is no literal left in the string for a
		// missing input to collapse onto.
		const p = fromJSProcessor(processor)();
		expect(p.getVersionHash()).toBe(`1.0.0-${simple_hash({config: undefined})}`);
		expect(p.getVersionHash()).not.toContain('not-configured');
	});

	it('gives an unconfigured processor and one configured with undefined the SAME hash', () => {
		// They are the same processor. The old form hashed them differently, so
		// calling `configure(undefined)` (or not calling it) decided whether stored
		// state was discarded, on no difference in behaviour at all.
		const never = fromJSProcessor(processor)();
		const configured = fromJSProcessor(processor)();
		configured.configure(undefined as never);
		expect(configured.getVersionHash()).toBe(never.getVersionHash());
	});

	it('changes when the processor config changes, including to a falsy value', () => {
		const a = fromJSProcessor(processor as JSProcessor<typeof abi, State, {fee: number}>)();
		a.configure({fee: 1});
		const b = fromJSProcessor(processor as JSProcessor<typeof abi, State, {fee: number}>)();
		b.configure({fee: 0});
		const none = fromJSProcessor(processor as JSProcessor<typeof abi, State, {fee: number}>)();

		expect(a.getVersionHash()).not.toBe(b.getVersionHash());
		// `{fee: 0}` used to hash like `{}`, so switching a fee OFF kept the state
		// computed while it was on
		expect(b.getVersionHash()).not.toBe(none.getVersionHash());
	});
});

describe('the code fingerprint', () => {
	it('is derived from the author handlers, and changes when one of them changes', () => {
		const original = fromJSProcessor(processor)();
		const editedProcessor: JSProcessor<typeof abi, State> = {
			...processor,
			onTransfer(state, event) {
				// same version, different logic: the case this whole task exists for
				state.owners[event.args.id.toString()] = event.args.from;
				state.transferCount++;
			},
		};
		const edited = fromJSProcessor(editedProcessor)();

		expect(original.getVersionHash()).toBe(edited.getVersionHash());
		expect(original.getCodeFingerprint()).toBeDefined();
		expect(original.getCodeFingerprint()).not.toBe(edited.getCodeFingerprint());
	});

	it('is identical for two instances of the same processor', () => {
		expect(fromJSProcessor(processor)().getCodeFingerprint()).toBe(fromJSProcessor(processor)().getCodeFingerprint());
	});

	it('does not move when only the version or the config changes', () => {
		// Otherwise a deliberate bump would also read as a code change, and the
		// version hash already covers both.
		const bumped: JSProcessor<typeof abi, State> = {...processor, version: '9.9.9'};
		const a = fromJSProcessor(processor)();
		const b = fromJSProcessor(bumped)();
		expect(a.getCodeFingerprint()).toBe(b.getCodeFingerprint());
	});
});

// -- end to end, at the fromJSProcessor seam ---------------------------------

const SOURCE: IndexingSource<typeof abi> = {
	chainId: '1',
	contracts: [{abi, address: '0x0000000000000000000000000000000000000001', startBlock: 0}],
};

function makeProvider() {
	return {
		async request({method}: {method: string}) {
			if (method === 'eth_chainId') return '0x1';
			if (method === 'eth_blockNumber') return '0x0';
			if (method === 'eth_getLogs') return [];
			throw new Error(`unexpected ${method}`);
		},
	} as any;
}

/**
 * An in-memory `KeepState`, standing in for IndexedDB / localStorage / the CLI's
 * snapshot file.
 *
 * A keeper is what makes drift detectable at all on this path: `lastSync` is
 * persisted ONLY through one, so a processor with no keeper has nowhere to write
 * a fingerprint. That is not a hole, it is the same fact from the other side:
 * with nothing persisted there is no stale state to serve.
 */
function memoryKeeper(): KeepState<typeof abi, State, {history: HistoryJSObject}, undefined> & {
	stored?: AllData<typeof abi, State, {history: HistoryJSObject}>;
} {
	const keeper: any = {
		fetch: async () => keeper.stored,
		save: async (_context: unknown, all: AllData<typeof abi, State, {history: HistoryJSObject}>) => {
			// Round-tripped through JSON with the SAME BigInt codec the real keepers use
			// (the core's tagged pair, which `keepStateOnLocalStorage` and the CLI's
			// snapshot both go through), REVIVER included: the reviver is what a
			// fingerprint travelling inside `lastSync` has to survive, so the fixture
			// has to run it rather than stop at the replacer.
			keeper.stored = JSON.parse(JSON.stringify(all, taggedBnReplacer), taggedBnReviver);
		},
		clear: async () => {
			keeper.stored = undefined;
		},
	};
	return keeper;
}

let logCounter = 0;
function transfer(blockNumber: number, blockHash: string): LogEvent<typeof abi> {
	logCounter++;
	return {
		blockNumber,
		blockHash,
		transactionIndex: 0,
		removed: false,
		address: '0x0000000000000000000000000000000000000001',
		data: '0x',
		topics: [],
		transactionHash: `0x${logCounter.toString(16).padStart(64, '0')}`,
		logIndex: 0,
		extra: undefined,
		eventName: 'Transfer',
		args: {from: '0x0', to: '0xalice', id: 1n},
	} as unknown as LogEvent<typeof abi>;
}

function lastSyncFetched(over: Partial<LastSync<typeof abi>> = {}): LastSync<typeof abi> {
	return {
		context: {source: [{startBlock: 0, hash: 'h'}], config: 'cfg', processor: 'proc'},
		latestBlock: 100,
		lastFromBlock: 0,
		lastToBlock: 100,
		unconfirmedBlocks: [],
		...over,
	};
}

/** Index one block with `p`, through a real indexer, so the keeper holds a real cursor. */
async function indexOneBlock(
	p: JSObjectEventProcessor<typeof abi, State, undefined>,
	keeper: ReturnType<typeof memoryKeeper>,
) {
	p.keepState(keeper as any);
	const indexer = new EthereumIndexer<typeof abi, State>(makeProvider(), p, SOURCE, {stream: {finality: 12}});
	await indexer.load();
	await indexer.feed([transfer(100, '0xAAA')], lastSyncFetched());
	return indexer;
}

/** Load `p` against a keeper that already holds someone else's state, collecting drift reports. */
async function reloadWith(
	p: JSObjectEventProcessor<typeof abi, State, undefined>,
	keeper: ReturnType<typeof memoryKeeper>,
	config: {strictProcessorDrift?: boolean} = {},
) {
	p.keepState(keeper as any);
	const reports: ProcessorDriftReport[] = [];
	const indexer = new EthereumIndexer<typeof abi, State>(makeProvider(), p, SOURCE, {
		stream: {finality: 12},
		...config,
	});
	indexer.onProcessorDrift = (report) => reports.push(report);
	return {indexer, reports, load: () => indexer.load()};
}

/** The same processor with an edited handler and a DELIBERATELY unchanged version. */
const editedSameVersion: JSProcessor<typeof abi, State> = {
	...processor,
	onTransfer(state, event) {
		state.owners[event.args.id.toString()] = event.args.from;
		state.transferCount++;
	},
};

describe('drift, end to end through a keeper', () => {
	it('persists the fingerprint with the cursor', async () => {
		const keeper = memoryKeeper();
		await indexOneBlock(fromJSProcessor(processor)(), keeper);

		expect(keeper.stored?.lastSync.context.processorFingerprint).toBe(
			fromJSProcessor(processor)().getCodeFingerprint(),
		);
	});

	it('reports when a handler changed but the version did not', async () => {
		const keeper = memoryKeeper();
		await indexOneBlock(fromJSProcessor(processor)(), keeper);

		const {reports, load} = await reloadWith(fromJSProcessor(editedSameVersion)(), keeper);
		await load();

		expect(reports).toHaveLength(1);
		expect(reports[0].processorHash).toBe(fromJSProcessor(processor)().getVersionHash());
		expect(reports[0].storedFingerprint).toBe(fromJSProcessor(processor)().getCodeFingerprint());
		expect(reports[0].currentFingerprint).toBe(fromJSProcessor(editedSameVersion)().getCodeFingerprint());
	});

	it('does not report when the version WAS bumped alongside the change', async () => {
		const keeper = memoryKeeper();
		await indexOneBlock(fromJSProcessor(processor)(), keeper);

		const bumped: JSProcessor<typeof abi, State> = {...editedSameVersion, version: '2.0.0'};
		const {reports, load} = await reloadWith(fromJSProcessor(bumped)(), keeper);
		await load();

		expect(reports).toEqual([]);
	});

	it('does not report for a byte-identical processor across a restart', async () => {
		const keeper = memoryKeeper();
		await indexOneBlock(fromJSProcessor(processor)(), keeper);

		const {reports, load} = await reloadWith(fromJSProcessor(processor)(), keeper);
		await load();

		expect(reports).toEqual([]);
	});

	it('does not report against a cursor written before fingerprints existed', async () => {
		const keeper = memoryKeeper();
		await indexOneBlock(fromJSProcessor(processor)(), keeper);
		// exactly what an upgraded deployment finds on disk: no such field
		delete (keeper.stored!.lastSync.context as {processorFingerprint?: string}).processorFingerprint;

		const {reports, load} = await reloadWith(fromJSProcessor(editedSameVersion)(), keeper);
		await load();

		expect(reports).toEqual([]);
	});

	it('refuses to start under strict mode, and starts without it', async () => {
		const keeper = memoryKeeper();
		await indexOneBlock(fromJSProcessor(processor)(), keeper);

		const strict = await reloadWith(fromJSProcessor(editedSameVersion)(), keeper, {strictProcessorDrift: true});
		await expect(strict.load()).rejects.toThrow(/PROCESSOR DRIFT/);

		const lenient = await reloadWith(fromJSProcessor(editedSameVersion)(), keeper);
		await expect(lenient.load()).resolves.toBeTruthy();
	});
});
