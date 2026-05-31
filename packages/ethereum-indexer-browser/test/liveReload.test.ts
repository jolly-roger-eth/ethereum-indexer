import {describe, expect, it} from 'vitest';
import type {Abi, EventProcessorWithInitialState, IndexingSource} from 'ethereum-indexer';
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
