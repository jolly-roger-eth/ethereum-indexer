import {describe, expect, it} from 'vitest';
import type {Abi} from 'abitype';
import {EthereumIndexer} from '../src/indexer';
import type {IndexingSource, LastSync, LogEvent} from '../src/types';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

// Minimal EIP-1193 provider mock. Returns deterministic data and records calls.
// Block timestamps are derived from the blockHash so we can assert per-hash mapping.
function makeProvider(opts: {
	chainId?: string;
	latestBlock: number;
	timestamps: {[blockHash: string]: number};
}) {
	const chainIdHex = '0x' + parseInt(opts.chainId || '1', 10).toString(16);
	const calls: {method: string; params?: any}[] = [];
	const provider = {
		async request(args: {method: string; params?: any}): Promise<any> {
			calls.push({method: args.method, params: args.params});
			switch (args.method) {
				case 'eth_chainId':
					return chainIdHex;
				case 'eth_blockNumber':
					return '0x' + opts.latestBlock.toString(16);
				case 'eth_getBlockByHash': {
					const hash = args.params[0] as string;
					const ts = opts.timestamps[hash];
					if (ts === undefined) {
						throw new Error(`unexpected eth_getBlockByHash for ${hash}`);
					}
					return {hash, timestamp: '0x' + ts.toString(16)};
				}
				default:
					throw new Error(`unexpected method ${args.method}`);
			}
		},
	};
	return {provider: provider as any, calls};
}

let logCounter = 0;
function makeLog(blockNumber: number, blockHash: string): any {
	logCounter++;
	return {
		blockNumber,
		blockHash,
		transactionIndex: 0,
		removed: false,
		address: '0x0000000000000000000000000000000000000000',
		data: '0x',
		topics: [],
		transactionHash: `0x${logCounter.toString(16).padStart(64, '0')}`,
		logIndex: 0,
		extra: undefined,
	};
}

const SOURCE: IndexingSource<Abi> = {
	chainId: '1',
	contracts: [{abi: [] as unknown as Abi, address: '0x0000000000000000000000000000000000000001', startBlock: 0}],
};

function freshLastSync(): LastSync<Abi> {
	return {
		context: {source: [{startBlock: 0, hash: 'h'}], config: 'cfg', processor: 'proc'},
		latestBlock: 0,
		lastFromBlock: 0,
		lastToBlock: 0,
		unconfirmedBlocks: [],
	};
}

const passThrough = <T>(p: Promise<T>) => p;

// Build an indexer whose log fetcher returns a fixed set of logs.
function makeIndexer(provider: any, logsToReturn: any[], latestBlock: number) {
	const processor: any = {
		getVersionHash: () => 'proc',
		load: async () => undefined,
		process: async () => undefined,
		reset: async () => {},
		clear: async () => {},
	};
	const indexer = new EthereumIndexer<Abi>(provider, processor, SOURCE, {
		stream: {finality: 12, alwaysFetchTimestamps: true},
	});
	// Stub the log fetcher to avoid real eth_getLogs decoding.
	(indexer as any).logEventFetcher = {
		getLogEvents: async () => ({events: logsToReturn, toBlockUsed: latestBlock}),
	};
	return indexer;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fetchLogsFromProvider - alwaysFetchTimestamps', () => {
	it('assigns a timestamp to every event in the typical monotonic-block case', async () => {
		const timestamps = {'0xaaa': 1000, '0xbbb': 2000};
		const {provider} = makeProvider({latestBlock: 200, timestamps});
		const logs = [makeLog(100, '0xaaa'), makeLog(101, '0xbbb')];
		const indexer = makeIndexer(provider, logs, 200);

		const {eventStream} = await (indexer as any).fetchLogsFromProvider(freshLastSync(), passThrough);

		const byHash: {[h: string]: LogEvent<Abi>} = {};
		for (const e of eventStream) byHash[(e as any).blockHash] = e;
		expect((byHash['0xaaa'] as any).blockTimestamp).toBe(1000);
		expect((byHash['0xbbb'] as any).blockTimestamp).toBe(2000);
	});

	it('assigns a timestamp to every event even when two different block hashes share the same block number', async () => {
		// This is the regression case: dedup keyed by block NUMBER would skip fetching the
		// timestamp for the second hash (same number, not strictly greater), leaving its
		// events with blockTimestamp === undefined.
		const timestamps = {'0xaaa': 1000, '0xbbb': 1500};
		const {provider} = makeProvider({latestBlock: 200, timestamps});
		const logs = [makeLog(100, '0xaaa'), makeLog(100, '0xbbb')];
		const indexer = makeIndexer(provider, logs, 200);

		const {eventStream} = await (indexer as any).fetchLogsFromProvider(freshLastSync(), passThrough);

		const byHash: {[h: string]: LogEvent<Abi>} = {};
		for (const e of eventStream) byHash[(e as any).blockHash] = e;
		expect((byHash['0xaaa'] as any).blockTimestamp).toBe(1000);
		// Before the fix, this would be undefined.
		expect((byHash['0xbbb'] as any).blockTimestamp).toBe(1500);
	});

	it('does not fetch the same block hash twice (deduplicates by hash)', async () => {
		const timestamps = {'0xaaa': 1000};
		const {provider, calls} = makeProvider({latestBlock: 200, timestamps});
		// Same block (hash 0xaaa) appears in two consecutive logs.
		const logs = [makeLog(100, '0xaaa'), makeLog(100, '0xaaa')];
		const indexer = makeIndexer(provider, logs, 200);

		await (indexer as any).fetchLogsFromProvider(freshLastSync(), passThrough);

		const blockFetches = calls.filter((c) => c.method === 'eth_getBlockByHash');
		expect(blockFetches).toHaveLength(1);
		expect(blockFetches[0].params[0]).toBe('0xaaa');
	});
});
