import type {Abi} from 'abitype';
import {describe, expect, it} from 'vitest';
import {LogEventFetcher, parseLogBlockTimestamp} from '../src/internal/decoding/LogEventFetcher.js';
import {IndexerGeneration} from '../src/indexer.js';
import type {IndexingSource, LastSync} from '../src/types.js';

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

/**
 * `events` may be an array or a FACTORY, and the factory form matters.
 *
 * `fetchLogsFromProvider` assigns `blockTimestamp` onto the event objects it is
 * given. A stub handing back the same array on every round would therefore carry
 * round 1's timestamps into round 2, and a "did not re-fetch" assertion would
 * pass because the events were already stamped rather than because anything was
 * cached. A real fetcher returns freshly decoded objects every time, so the
 * factory form is the honest one for any multi-round test.
 */
function makeIndexer(provider: any, events: any[] | (() => any[]), alwaysFetchTimestamps = true) {
	const processor: any = {
		getVersionHash: () => 'proc',
		// required on `EventProcessor`: a fake that omits it is a fake that would
		// lose drift detection without anybody noticing
		getCodeFingerprint: () => undefined,
		load: async () => undefined,
		process: async () => undefined,
		reset: async () => {},
		clear: async () => {},
	};
	const indexer = new IndexerGeneration<Abi>(provider, processor, SOURCE, {
		stream: {finality: 12, alwaysFetchTimestamps},
	});
	(indexer as any).logEventFetcher = {
		getLogEvents: async () => ({events: typeof events === 'function' ? events() : events, toBlockUsed: 200}),
	};
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

	it('does not re-fetch a block it already has a timestamp for', async () => {
		// `getFromBlock` deliberately re-scans back to `latestBlock - finality` every
		// round to catch reorgs, so on a node that does not supply timestamps the same
		// unconfirmed blocks come back round after round. Without a cache each one is
		// re-fetched every time: 3 blocks over 5 rounds cost 15 `eth_getBlockByHash`.
		const {provider, calls} = makeProvider({'0xaaa': 1000, '0xbbb': 2000, '0xccc': 3000});
		// blocks 195/196 against latestBlock 200 and finality 12: inside the re-scan
		// window, so they legitimately come back round after round
		let withNewBlock = false;
		const indexer = makeIndexer(provider, () =>
			withNewBlock
				? [event(195, '0xaaa'), event(196, '0xbbb'), event(197, '0xccc')]
				: [event(195, '0xaaa'), event(196, '0xbbb')],
		);

		const first = await (indexer as any).fetchLogsFromProvider(freshLastSync(), passThrough);
		expect(calls.filter((c) => c.method === 'eth_getBlockByHash')).toHaveLength(2);
		expect(first.eventStream.map((e: any) => e.blockTimestamp)).toEqual([1000, 2000]);

		// the re-scan returns both blocks again, plus one genuinely new one
		withNewBlock = true;
		calls.length = 0;
		const second = await (indexer as any).fetchLogsFromProvider(first.lastSync, passThrough);

		// only the NEW block costs a round-trip; the two re-scanned ones are cached
		const fetched = calls.filter((c) => c.method === 'eth_getBlockByHash');
		expect(fetched).toHaveLength(1);
		expect(fetched[0].params[0]).toBe('0xccc');
		// and only the new block is appended, still correctly stamped
		expect(second.eventStream.map((e: any) => e.blockTimestamp)).toEqual([3000]);
	});

	it('fetches a REORGED block again, because the cache is keyed by hash not height', async () => {
		// The load-bearing property. Keying by block number would answer block 100's
		// new hash with the DEAD branch's timestamp, and it would do so silently,
		// across exactly the reorg the re-scan window exists to detect.
		const {provider, calls} = makeProvider({'0xaaa': 1000, '0xdead': 9999});
		const indexer = makeIndexer(provider, () => [event(195, '0xaaa')]);

		const first = await (indexer as any).fetchLogsFromProvider(freshLastSync(), passThrough);
		expect(first.eventStream[0].blockTimestamp).toBe(1000);

		// block 195 is replaced: same height, different hash, different timestamp
		(indexer as any).logEventFetcher = {
			getLogEvents: async () => ({events: [event(195, '0xdead')], toBlockUsed: 200}),
		};
		calls.length = 0;
		const second = await (indexer as any).fetchLogsFromProvider(first.lastSync, passThrough);

		const fetched = second.eventStream.filter((e: any) => !e.removed);
		expect(fetched[0].blockTimestamp).toBe(9999);
		expect(calls.filter((c) => c.method === 'eth_getBlockByHash')).toHaveLength(1);
	});

	it('does not grow without bound: entries below finality are evicted', async () => {
		// `getFromBlock` never re-scans below `latestBlock - finality`, so an entry
		// below it can never be needed again. That bound is what keeps a long sync
		// from accumulating one entry per block of the whole chain.
		const {provider} = makeProvider({'0xaaa': 1000, '0xbbb': 2000});
		// block 195 is inside the window against latestBlock 200...
		const indexer = makeIndexer(provider, () => [event(195, '0xaaa')]);
		await (indexer as any).fetchLogsFromProvider(freshLastSync(), passThrough);
		expect((indexer as any).blockTimestampCache.size).toBe(1);

		// ...and block 100 is not: 200 - 100 = 100 > finality, so it is evicted in the
		// same round it would have been cached, never mind later ones.
		const other = makeIndexer(provider, () => [event(100, '0xbbb')]);
		await (other as any).fetchLogsFromProvider(freshLastSync(), passThrough);
		expect((other as any).blockTimestampCache.size).toBe(0);
	});

	it('caches nothing on a node that puts the timestamp on the log', async () => {
		// The cache exists only for the fallback path; a compliant node should not pay
		// even the memory for it.
		const {provider} = makeProvider({});
		const indexer = makeIndexer(provider, () => [event(195, '0xaaa', 1000)]);

		await (indexer as any).fetchLogsFromProvider(freshLastSync(), passThrough);

		expect((indexer as any).blockTimestampCache.size).toBe(0);
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
