import type {Abi} from 'abitype';
import {describe, expect, it} from 'vitest';
import {LogEventFetcher, parseLogBlockTimestamp} from '../src/internal/decoding/LogEventFetcher';
import {EthereumIndexer} from '../src/indexer';
import type {IndexingSource, LastSync} from '../src/types';

// ---------------------------------------------------------------------------
// `blockTimestamp` comes off the log when the node provides it
// ---------------------------------------------------------------------------
// `ethereum/execution-apis#639` (merged 2025-08-25) puts `blockTimestamp` on
// every log object. geth >= 1.16.0, reth, besu, erigon and anvil all serve it;
// Hardhat's EDR does not, as of hardhat 3.14.0 / edr 0.3.8, which is why the
// `alwaysFetchTimestamps` fallback still exists rather than being deleted.
//
// What is pinned here is that the fallback is now a FALLBACK: a node that puts
// the timestamp on the log costs zero extra requests. That matters most exactly
// where it is hardest to see, the in-browser path ADR-0002 makes primary, where
// a provider often cannot batch `eth_getBlockByHash` at all and every block is
// its own round-trip.
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

const ADDRESS = '0x0000000000000000000000000000000000000001';

function rawLog(over: Record<string, unknown> = {}) {
	return {
		blockNumber: '0x64',
		blockHash: '0xaaa',
		transactionIndex: '0x0',
		removed: false,
		address: ADDRESS,
		data: '0x',
		topics: [],
		transactionHash: `0x${'1'.padStart(64, '0')}`,
		logIndex: '0x0',
		...over,
	} as any;
}

describe('parseLogBlockTimestamp', () => {
	it('reads a 0x-prefixed hex QUANTITY, which is what the spec says', () => {
		// exactly the shape anvil 1.5.1 returns
		expect(parseLogBlockTimestamp('0x6a886a9d')).toBe(0x6a886a9d);
	});

	it('reads a bare decimal string, because at least one client serves it that way', () => {
		expect(parseLogBlockTimestamp('1700000000')).toBe(1700000000);
	});

	it('reads a plain number', () => {
		expect(parseLogBlockTimestamp(1700000000)).toBe(1700000000);
	});

	it('treats anything else as ABSENT rather than coercing it to 0', () => {
		// A missing timestamp is recoverable: the caller fetches the block. A wrong
		// one is not: 0 sorts before every block and poisons time addressing
		// silently. So an unreadable value must not become a number.
		expect(parseLogBlockTimestamp(undefined)).toBeUndefined();
		expect(parseLogBlockTimestamp(null)).toBeUndefined();
		expect(parseLogBlockTimestamp('')).toBeUndefined();
		expect(parseLogBlockTimestamp('later')).toBeUndefined();
		expect(parseLogBlockTimestamp('0x')).toBeUndefined();
		expect(parseLogBlockTimestamp(-1)).toBeUndefined();
	});
});

describe('LogEventFetcher.parse', () => {
	const fetcher = new LogEventFetcher({request: async () => undefined} as any, [{abi, address: ADDRESS}]);

	it('keeps the timestamp the node put on the log', () => {
		const [event] = fetcher.parse([rawLog({blockTimestamp: '0x6a886a9d'})]);
		expect(event.blockTimestamp).toBe(0x6a886a9d);
	});

	it('leaves it undefined when the node omits it, rather than inventing one', () => {
		const [event] = fetcher.parse([rawLog()]);
		expect(event.blockTimestamp).toBeUndefined();
	});
});

// -- the indexer seam --------------------------------------------------------

const SOURCE: IndexingSource<Abi> = {
	chainId: '1',
	contracts: [{abi: [] as unknown as Abi, address: ADDRESS, startBlock: 0}],
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

function makeProvider(timestamps: {[blockHash: string]: number}) {
	const calls: {method: string; params?: any}[] = [];
	const provider = {
		async request(args: {method: string; params?: any}): Promise<any> {
			calls.push({method: args.method, params: args.params});
			switch (args.method) {
				case 'eth_chainId':
					return '0x1';
				case 'eth_blockNumber':
					return '0xc8';
				case 'eth_getBlockByHash': {
					const hash = args.params[0] as string;
					const ts = timestamps[hash];
					if (ts === undefined) throw new Error(`unexpected eth_getBlockByHash for ${hash}`);
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
function event(blockNumber: number, blockHash: string, blockTimestamp?: number): any {
	logCounter++;
	return {
		blockNumber,
		blockHash,
		transactionIndex: 0,
		removed: false,
		address: ADDRESS,
		data: '0x',
		topics: [],
		transactionHash: `0x${logCounter.toString(16).padStart(64, '0')}`,
		logIndex: 0,
		extra: undefined,
		...(blockTimestamp === undefined ? {} : {blockTimestamp}),
	};
}

function makeIndexer(provider: any, events: any[], alwaysFetchTimestamps = true) {
	const processor: any = {
		getVersionHash: () => 'proc',
		load: async () => undefined,
		process: async () => undefined,
		reset: async () => {},
		clear: async () => {},
	};
	const indexer = new EthereumIndexer<Abi>(provider, processor, SOURCE, {
		stream: {finality: 12, alwaysFetchTimestamps},
	});
	(indexer as any).logEventFetcher = {getLogEvents: async () => ({events, toBlockUsed: 200})};
	return indexer;
}

describe('the indexer only fetches blocks whose logs lack a timestamp', () => {
	it('makes NO block request when every log carries its own timestamp', async () => {
		const {provider, calls} = makeProvider({});
		const indexer = makeIndexer(provider, [event(100, '0xaaa', 1000), event(101, '0xbbb', 2000)]);

		const {eventStream} = await (indexer as any).fetchLogsFromProvider(freshLastSync(), passThrough);

		expect(calls.filter((c) => c.method === 'eth_getBlockByHash')).toHaveLength(0);
		expect(eventStream.map((e: any) => e.blockTimestamp)).toEqual([1000, 2000]);
	});

	it('fetches only the blocks that are missing one, not the whole range', async () => {
		// A node that supplies timestamps for some logs and not others is odd, but
		// the useful property is the general one: the fetch list is built from what
		// is actually absent, so it shrinks to nothing on a compliant node.
		const {provider, calls} = makeProvider({'0xbbb': 2000});
		const indexer = makeIndexer(provider, [event(100, '0xaaa', 1000), event(101, '0xbbb')]);

		const {eventStream} = await (indexer as any).fetchLogsFromProvider(freshLastSync(), passThrough);

		const fetches = calls.filter((c) => c.method === 'eth_getBlockByHash');
		expect(fetches).toHaveLength(1);
		expect(fetches[0].params[0]).toBe('0xbbb');
		expect(eventStream.map((e: any) => e.blockTimestamp)).toEqual([1000, 2000]);
	});

	it('still fetches every block on a node that supplies none (the Hardhat case)', async () => {
		const {provider, calls} = makeProvider({'0xaaa': 1000, '0xbbb': 2000});
		const indexer = makeIndexer(provider, [event(100, '0xaaa'), event(101, '0xbbb')]);

		const {eventStream} = await (indexer as any).fetchLogsFromProvider(freshLastSync(), passThrough);

		expect(calls.filter((c) => c.method === 'eth_getBlockByHash')).toHaveLength(2);
		expect(eventStream.map((e: any) => e.blockTimestamp)).toEqual([1000, 2000]);
	});

	it('keeps the log timestamp even without alwaysFetchTimestamps, for free', async () => {
		// The flag now means "fall back to fetching when the node does not supply
		// it", not "this is the only way to get one". Turning it off must not throw
		// away a timestamp that already arrived.
		const {provider, calls} = makeProvider({});
		const indexer = makeIndexer(provider, [event(100, '0xaaa', 1000)], false);

		const {eventStream} = await (indexer as any).fetchLogsFromProvider(freshLastSync(), passThrough);

		expect(calls.filter((c) => c.method === 'eth_getBlockByHash')).toHaveLength(0);
		expect(eventStream[0].blockTimestamp).toBe(1000);
	});
});
