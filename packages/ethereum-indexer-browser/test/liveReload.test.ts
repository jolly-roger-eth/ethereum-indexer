import {describe, expect, it} from 'vitest';
import type {Abi, EventProcessorWithInitialState, IndexingSource} from 'ethereum-indexer';
import {EthereumIndexer} from 'ethereum-indexer';
import {createIndexerState} from '../src/IndexerState';

// chainId '1' as the 0x-hex the provider returns
const CHAIN_ID_HEX = '0x1';
// a *different* chain id, used to simulate a provider connected to another chain
const OTHER_CHAIN_ID_HEX = '0x5';

function makeProvider(chainIdHex: string = CHAIN_ID_HEX) {
	return {
		async request(args: {method: string; params?: any}): Promise<any> {
			switch (args.method) {
				case 'eth_chainId':
					return chainIdHex;
				case 'eth_blockNumber':
					return '0x0';
				case 'eth_getLogs':
					return [];
				default:
					throw new Error(`unexpected method ${args.method}`);
			}
		},
	} as any;
}

type State = {count: number};

function makeProcessor(versionHash = 'v1'): EventProcessorWithInitialState<Abi, State, undefined> {
	return {
		getVersionHash: () => versionHash,
		createInitialState: () => ({count: 0}),
		configure: () => {},
		load: async () => undefined,
		process: async () => ({count: 0}),
		reset: async () => {},
		clear: async () => {},
	};
}

const SOURCE: IndexingSource<Abi> = {
	chainId: '1',
	contracts: [{abi: [] as unknown as Abi, address: '0x0000000000000000000000000000000000000001', startBlock: 0}],
};

// a new source (e.g. a newly deployed contract) on the SAME chain so updateIndexer resets cleanly
const NEW_SOURCE: IndexingSource<Abi> = {
	chainId: '1',
	contracts: [
		{abi: [] as unknown as Abi, address: '0x0000000000000000000000000000000000000001', startBlock: 0},
		{abi: [] as unknown as Abi, address: '0x0000000000000000000000000000000000000002', startBlock: 0},
	],
};

describe('createIndexerState - live reload (HIGH #1: async + error routing)', () => {
	it('updateIndexer returns an awaitable promise and routes core errors to $syncing.error', async () => {
		const indexer = createIndexerState<Abi, State>(makeProcessor());
		await indexer.init({provider: makeProvider(), source: SOURCE});

		// do an initial load so the indexer is in a stable state
		await indexer.indexMore();

		// Reconfigure with a provider connected to a DIFFERENT chain but no new source.
		// The core updateIndexer performs an async chainId check and rejects in this case.
		// The browser wrapper must (a) return a promise we can await/catch, and
		// (b) route the failure into $syncing.error rather than leaving an unhandled rejection.
		const result = indexer.updateIndexer({provider: makeProvider(OTHER_CHAIN_ID_HEX)});

		// It must be awaitable (a promise), not a synchronous void.
		expect(result).toBeInstanceOf(Promise);

		await expect(result).rejects.toBeTruthy();

		expect(indexer.syncing.$state.error).toBeDefined();
	});
});

describe('createIndexerState - live reload (HIGH #2: clear syncing state on reconfigure)', () => {
	it('clears $syncing.lastSync on updateIndexer so setupIndexing re-runs for the new config', async () => {
		const indexer = createIndexerState<Abi, State>(makeProcessor());
		await indexer.init({provider: makeProvider(), source: SOURCE});

		// initial load -> $syncing.lastSync becomes populated
		await indexer.indexMore();
		expect(indexer.syncing.$state.lastSync).toBeDefined();

		// reconfigure with a NEW source (new contract). The core indexer is re-init'd / reset.
		await indexer.updateIndexer({source: NEW_SOURCE});

		// The browser wrapper must clear its own stale lastSync so setupIndexing() does NOT
		// early-return with progress computed against the old configuration.
		expect(indexer.syncing.$state.lastSync).toBeUndefined();
	});

	it('does NOT clear $syncing.lastSync when the core reconfigure fails (option b)', async () => {
		const indexer = createIndexerState<Abi, State>(makeProcessor());
		await indexer.init({provider: makeProvider(), source: SOURCE});

		await indexer.indexMore();
		expect(indexer.syncing.$state.lastSync).toBeDefined();

		// A failing reconfigure (different chain, no new source) must leave the previous
		// valid progress intact while surfacing the error.
		await expect(indexer.updateIndexer({provider: makeProvider(OTHER_CHAIN_ID_HEX)})).rejects.toBeTruthy();

		expect(indexer.syncing.$state.lastSync).toBeDefined();
		expect(indexer.syncing.$state.error).toBeDefined();
	});
});

describe('createIndexerState - live reload (MEDIUM #3: pause auto-indexing during reconfigure)', () => {
	it('pauses auto-indexing while a reconfigure is in flight and resumes it after', async () => {
		// Gate we resolve manually to keep the core updateIndexer "in flight".
		let releaseReconfigure!: () => void;
		const reconfigureGate = new Promise<void>((resolve) => (releaseReconfigure = resolve));

		const indexer = createIndexerState<Abi, State>(makeProcessor(), {
			createIndexer: (provider, processor, source, config) => {
				const real = new EthereumIndexer<Abi, State>(provider, processor, source, config);
				const realUpdateIndexer = real.updateIndexer.bind(real);
				real.updateIndexer = (async (update: any) => {
					// stay in flight until the test releases the gate
					await reconfigureGate;
					return realUpdateIndexer(update);
				}) as any;
				return real;
			},
		});
		await indexer.init({provider: makeProvider(), source: SOURCE});

		// start the auto-index loop (long interval so its timer does not interfere with this test)
		await indexer.startAutoIndexing(3600);
		expect(indexer.syncing.$state.autoIndexing).toBe(true);

		// kick off a reconfigure that stays in flight (gated)
		const reconfiguring = indexer.updateIndexer({source: NEW_SOURCE});
		// let the synchronous part of updateIndexer run up to the gate
		await Promise.resolve();

		// BUG (#3): auto-indexing keeps running during the reconfigure. With the fix it is paused
		// for the duration so a timer tick cannot race the mid-reinit core.
		expect(indexer.syncing.$state.autoIndexing).toBe(false);

		// release the reconfigure and let it complete
		releaseReconfigure();
		await reconfiguring;

		// auto-indexing should be resumed after the reconfigure
		expect(indexer.syncing.$state.autoIndexing).toBe(true);

		// cleanup: stop the loop so no timers leak
		indexer.stopAutoIndexing();
	});
});
