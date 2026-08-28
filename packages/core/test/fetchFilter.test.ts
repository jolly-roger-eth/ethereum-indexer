import type {Abi} from 'abitype';
import {describe, expect, it} from 'vitest';
import {LogEventFetcher} from '../src/internal/decoding/LogEventFetcher.js';
import type {LogParseConfig} from '../src/types.js';

// ---------------------------------------------------------------------------
// AN EVENT IS NEVER SILENTLY DROPPED FROM THE FETCH FILTER
// ---------------------------------------------------------------------------
// `deleteDuplicateEvents` used to key on the event NAME, and the two call sites
// disagreed about what to do with a clash: the per-address merge threw, and the
// global list -- the one the fetch filter is built from -- spliced the second
// event out with no error, no log and no metric. Afterwards nothing could tell
// "the chain had none" from "we never asked", because the dropped event's
// topic0 was not in the filter to check with. That is the same failure class as
// `absence` vs `contradiction` in the reorg model, and as
// `SuspectedTruncationError`: an absence inferred from a request never made.
//
// So the assertions here are on the topics the fetcher REQUESTS, not on the ABI
// it accepted. What it accepted was never the thing that was wrong.
//
// The rule is now keyed on topic0 and is the SAME on both paths:
//
//   - different topic0  -> both events kept, whatever their names;
//   - same topic0, identical definition -> collapsed to one, no error;
//   - same topic0, different definition -> REFUSED at construction, naming the
//     events, because nothing on the wire can tell those two apart.
// ---------------------------------------------------------------------------

const A = '0x0000000000000000000000000000000000000001' as const;
const B = '0x0000000000000000000000000000000000000002' as const;

// topic0s, as viem encodes them, of the signatures used below
const TRANSFER_V1 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'; // Transfer(address,address,uint256)
const TRANSFER_V2 = '0xe19260aff97b920c7df27010903aeb9c8d2be5d310a2c67824cf3f15396e4c16'; // Transfer(address,address,uint256,bytes)
const TRANSFER_OTHER = '0x69ca02dd4edd7bf0a4abb9ed3b7af3f14778db5d61921c7dc7cd545266326de2'; // Transfer(address,uint256)

/** `Transfer(address,address,uint256)` -- the pre-upgrade signature. */
const transferV1 = {
	type: 'event',
	name: 'Transfer',
	anonymous: false,
	inputs: [
		{indexed: true, name: 'from', type: 'address'},
		{indexed: true, name: 'to', type: 'address'},
		{indexed: false, name: 'id', type: 'uint256'},
	],
} as const;

/** `Transfer(address,address,uint256,bytes)` -- the post-upgrade signature, a different topic0. */
const transferV2 = {
	type: 'event',
	name: 'Transfer',
	anonymous: false,
	inputs: [
		{indexed: true, name: 'from', type: 'address'},
		{indexed: true, name: 'to', type: 'address'},
		{indexed: false, name: 'id', type: 'uint256'},
		{indexed: false, name: 'memo', type: 'bytes'},
	],
} as const;

/** Another contract's `Transfer`, same NAME and a different topic0. Nothing to do with upgrades. */
const transferOther = {
	type: 'event',
	name: 'Transfer',
	anonymous: false,
	inputs: [
		{indexed: true, name: 'to', type: 'address'},
		{indexed: false, name: 'amount', type: 'uint256'},
	],
} as const;

/**
 * The SAME signature as `transferV1`, so the SAME topic0, but decoding into
 * something else: no `indexed` flags, so the values ride in `data`. A log
 * carrying that topic0 is genuinely ambiguous.
 */
const transferV1Colliding = {
	type: 'event',
	name: 'Transfer',
	anonymous: false,
	inputs: [
		{indexed: false, name: 'from', type: 'address'},
		{indexed: false, name: 'to', type: 'address'},
		{indexed: false, name: 'id', type: 'uint256'},
	],
} as const;

const passThrough = <T>(p: Promise<T>) => p;

/**
 * A provider that answers no logs and records what it was ASKED for.
 *
 * The point of the whole file: an event that never enters the filter produces an
 * empty result that looks exactly like a quiet chain.
 */
function recordingProvider() {
	const requests: {address?: string[]; topics?: (string | string[])[]}[] = [];
	const provider = {
		async request(args: {method: string; params?: any}): Promise<any> {
			if (args.method !== 'eth_getLogs') throw new Error(`unexpected method ${args.method}`);
			requests.push(args.params[0]);
			return [];
		},
	};
	return {provider: provider as any, requests};
}

/**
 * Every topic0 the fetcher put in front of the node for one block range, across
 * every request it made (a filtered config issues one request per topic).
 */
async function topicsRequested(
	contractsData: any,
	parseConfig?: LogParseConfig,
	range: {fromBlock: number; toBlock: number} = {fromBlock: 100, toBlock: 110},
): Promise<string[]> {
	const {provider, requests} = recordingProvider();
	const fetcher = new LogEventFetcher(provider, contractsData, {}, parseConfig);
	await fetcher.getLogEvents({...range, retry: 0}, passThrough);
	const topics: string[] = [];
	for (const request of requests) {
		const topic0 = request.topics?.[0];
		for (const topic of Array.isArray(topic0) ? topic0 : topic0 ? [topic0] : []) {
			if (topics.indexOf(topic) === -1) topics.push(topic);
		}
	}
	return topics;
}

/** The same source, asked for under both readings of the parse config. */
const BOTH_PATHS: {label: string; parse: LogParseConfig}[] = [
	{label: 'per-address', parse: {}},
	{label: 'address-agnostic', parse: {parseAllEventsIrrespectiveOfAddresses: true}},
];

// ---------------------------------------------------------------------------

describe('an event is never silently dropped from the fetch filter', () => {
	it('REGRESSION: two contracts declaring same-named events with different inputs both reach the request', async () => {
		// This is the silent path. Keyed on NAME, the second contract's `Transfer`
		// was spliced out of the global list, so its topic0 never entered the
		// filter and its logs were never asked for -- with no error to notice.
		const contracts = [
			{address: A, abi: [transferV1] as unknown as Abi},
			{address: B, abi: [transferOther] as unknown as Abi},
		];

		const topics = await topicsRequested(contracts);

		expect(topics).toContain(TRANSFER_V1);
		expect(topics).toContain(TRANSFER_OTHER);
	});

	it('requests both topic0s whether or not parseAllEventsIrrespectiveOfAddresses is set', async () => {
		const contracts = [
			{address: A, abi: [transferV1] as unknown as Abi},
			{address: B, abi: [transferOther] as unknown as Abi},
		];

		const perAddress = await topicsRequested(contracts, BOTH_PATHS[0].parse);
		const agnostic = await topicsRequested(contracts, BOTH_PATHS[1].parse);

		// the flag chooses which ABI DECODES a log; it must never choose which
		// events exist, and so never which logs are fetched at all
		expect(agnostic).toEqual(perAddress);
		expect(perAddress.sort()).toEqual([TRANSFER_V1, TRANSFER_OTHER].sort());
	});

	it('carries every topic0 into the filter even when a filter list is configured for the name', async () => {
		// with argument filters, one request per (topic x filter): a name covering
		// two topic0s must produce a request for each, or one version is filtered
		// and the other silently unrequested
		const contracts = [{address: A, abi: [transferV1, transferV2] as unknown as Abi}];
		const holder = `0x${'11'.repeat(20)}`.padEnd(66, '0') as `0x${string}`;

		const topics = await topicsRequested(contracts, {filters: {Transfer: [[holder]]}});

		expect(topics.sort()).toEqual([TRANSFER_V1, TRANSFER_V2].sort());
	});
});

describe('two versions of one contract event across an upgrade', () => {
	const upgraded = [{address: A, abi: [transferV1, transferV2] as unknown as Abi}];

	for (const {label, parse} of BOTH_PATHS) {
		it(`keeps both versions and requests both topic0s (${label})`, async () => {
			const topics = await topicsRequested(upgraded, parse);
			expect(topics.sort()).toEqual([TRANSFER_V1, TRANSFER_V2].sort());
		});
	}

	it('requests both versions together at a SINGLE block, since the upgrade tx sits mid-block', async () => {
		// a transaction earlier in the upgrade block still fires the old event, so
		// the two versions overlap on exactly one block and both must be asked for
		const topics = await topicsRequested(upgraded, {}, {fromBlock: 900, toBlock: 900});
		expect(topics.sort()).toEqual([TRANSFER_V1, TRANSFER_V2].sort());
	});

	it('decodes each version by its own topic0, with no block axis', () => {
		const fetcher = new LogEventFetcher({request: async () => undefined} as any, upgraded as any);
		const from = `0x${'0'.repeat(24)}${A.slice(2)}` as const;
		const to = `0x${'0'.repeat(24)}${B.slice(2)}` as const;
		const [v1, v2] = fetcher.parse([
			{
				blockNumber: '0x64',
				blockHash: '0xaaa',
				transactionIndex: '0x0',
				removed: false,
				address: A,
				data: `0x${(7).toString(16).padStart(64, '0')}`,
				topics: [TRANSFER_V1, from, to],
				transactionHash: `0x${'1'.padStart(64, '0')}`,
				logIndex: '0x0',
			},
			{
				blockNumber: '0x64',
				blockHash: '0xaaa',
				transactionIndex: '0x1',
				removed: false,
				address: A,
				// (uint256 id, bytes memo): head, offset, length, padded bytes
				data:
					`0x${(9).toString(16).padStart(64, '0')}` +
					`${(64).toString(16).padStart(64, '0')}` +
					`${(2).toString(16).padStart(64, '0')}` +
					`beef${'0'.repeat(60)}`,
				topics: [TRANSFER_V2, from, to],
				transactionHash: `0x${'2'.padStart(64, '0')}`,
				logIndex: '0x1',
			},
		] as any);

		expect((v1 as any).eventName).toBe('Transfer');
		expect((v1 as any).args).toMatchObject({id: 7n});
		expect((v1 as any).args.memo).toBeUndefined();
		expect((v2 as any).eventName).toBe('Transfer');
		expect((v2 as any).args).toMatchObject({id: 9n, memo: '0xbeef'});
	});
});

describe('a genuinely ambiguous ABI is refused, loudly, on every path', () => {
	// One topic0 meaning two things cannot be resolved by anything on the wire, and
	// no block boundary helps either: the upgrade tx sits mid-block, so both
	// meanings share a block.
	const arrangements: {label: string; contractsData: any}[] = [
		{
			label: 'one contract declaring both',
			contractsData: [{address: A, abi: [transferV1, transferV1Colliding] as unknown as Abi}],
		},
		{
			label: 'two contracts declaring one each',
			contractsData: [
				{address: A, abi: [transferV1] as unknown as Abi},
				{address: B, abi: [transferV1Colliding] as unknown as Abi},
			],
		},
		{
			label: 'the same address twice',
			contractsData: [
				{address: A, abi: [transferV1] as unknown as Abi},
				{address: A, abi: [transferV1Colliding] as unknown as Abi},
			],
		},
		{
			label: 'a single merged ABI',
			contractsData: {abi: [transferV1, transferV1Colliding] as unknown as Abi},
		},
	];

	for (const {label, contractsData} of arrangements) {
		for (const {label: pathLabel, parse} of BOTH_PATHS) {
			it(`refuses at construction, naming the events (${label}, ${pathLabel})`, () => {
				const build = () => new LogEventFetcher({request: async () => undefined} as any, contractsData, {}, parse);
				expect(build).toThrow(/Transfer\(address,address,uint256\)/);
				// the topic0 they collide on, so an operator can find them in the ABI
				expect(build).toThrow(new RegExp(TRANSFER_V1));
			});
		}
	}
});

describe('the legitimate de-duplication still works', () => {
	const shared = [
		{address: A, abi: [transferV1] as unknown as Abi},
		{address: B, abi: [transferV1] as unknown as Abi},
	];

	for (const {label, parse} of BOTH_PATHS) {
		it(`collapses an IDENTICAL event declared by two contracts, without error (${label})`, async () => {
			const topics = await topicsRequested(shared, parse);
			expect(topics).toEqual([TRANSFER_V1]);
		});
	}

	it('collapses it in the per-address list too, when both entries are the same address', () => {
		const fetcher = new LogEventFetcher(
			{request: async () => undefined} as any,
			[
				{address: A, abi: [transferV1] as unknown as Abi},
				{address: A, abi: [transferV1, transferV2] as unknown as Abi},
			] as any,
		);

		const log = {
			blockNumber: '0x64',
			blockHash: '0xaaa',
			transactionIndex: '0x0',
			removed: false,
			address: A,
			data: `0x${(7).toString(16).padStart(64, '0')}`,
			topics: [TRANSFER_V1, `0x${'0'.repeat(24)}${A.slice(2)}`, `0x${'0'.repeat(24)}${B.slice(2)}`],
			transactionHash: `0x${'1'.padStart(64, '0')}`,
			logIndex: '0x0',
		};

		// a duplicated declaration must not make the log undecodable
		const [event] = fetcher.parse([log] as any);
		expect((event as any).eventName).toBe('Transfer');
	});
});
