import {describe, expect, it} from 'vitest';
import type {Abi, EventProcessorWithInitialState, IndexingSource} from 'ethereum-indexer';
import {EthereumIndexer} from 'ethereum-indexer';
import {createIndexerState} from '../src/IndexerState.js';

const CHAIN_ID_HEX = '0x1';

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

describe('createIndexerState - dispose() (teardown / leak prevention)', () => {
	it('exposes a dispose() method', async () => {
		const indexer = createIndexerState<Abi, State>(makeProcessor());
		expect(typeof (indexer as any).dispose).toBe('function');
	});

	it('stops the auto-index loop so no further ticks fire after dispose()', async () => {
		let indexMoreCalls = 0;
		const indexer = createIndexerState<Abi, State>(makeProcessor(), {
			createIndexer: (provider, processor, source, config) => {
				const real = new EthereumIndexer<Abi, State>(provider, processor, source, config);
				const realIndexMore = real.indexMore.bind(real);
				real.indexMore = (async (...args: any[]) => {
					indexMoreCalls++;
					return (realIndexMore as any)(...args);
				}) as any;
				return real;
			},
		});
		await indexer.init({provider: makeProvider(), source: SOURCE});

		// start the loop with a very short interval so ticks keep re-arming quickly
		await indexer.startAutoIndexing(0.01);
		expect(indexer.syncing.$state.autoIndexing).toBe(true);

		// let a few ticks happen
		await new Promise((r) => setTimeout(r, 60));

		// dispose must clear the timer AND mark autoIndexing false
		await (indexer as any).dispose();
		expect(indexer.syncing.$state.autoIndexing).toBe(false);

		const callsAfterDispose = indexMoreCalls;

		// wait well past several intervals: a leaked self-re-arming setTimeout would keep calling
		// indexMore. After dispose it must not increase.
		await new Promise((r) => setTimeout(r, 100));
		expect(indexMoreCalls).toBe(callsAfterDispose);
	});

	it('detaches the indexer callbacks (onLoad / onLastSyncUpdated / onStateUpdated) on dispose()', async () => {
		let captured!: EthereumIndexer<Abi, State>;
		const indexer = createIndexerState<Abi, State>(makeProcessor(), {
			createIndexer: (provider, processor, source, config) => {
				captured = new EthereumIndexer<Abi, State>(provider, processor, source, config);
				return captured;
			},
		});
		await indexer.init({provider: makeProvider(), source: SOURCE});

		// wire the callbacks (setupIndexing sets them)
		await indexer.indexMore();
		expect(captured.onLoad).toBeDefined();
		expect(captured.onLastSyncUpdated).toBeDefined();
		expect(captured.onStateUpdated).toBeDefined();

		await (indexer as any).dispose();

		expect(captured.onLoad).toBeUndefined();
		expect(captured.onLastSyncUpdated).toBeUndefined();
		expect(captured.onStateUpdated).toBeUndefined();
	});
});
