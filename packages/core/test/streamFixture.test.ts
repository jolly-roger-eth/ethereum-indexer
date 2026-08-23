import {describe, expect, it} from 'vitest';
import type {Abi} from 'abitype';
import {captureStream} from '../src/stream/capture.js';
import {
	blocksOf,
	parseStreamFixture,
	replayFixtureInto,
	replayStream,
	serializeStreamFixture,
	STREAM_FIXTURE_FORMAT,
	type StreamFixture,
} from '../src/stream/fixture.js';
import type {EventProcessor, IndexingSource, LastSync, LogEvent, UsedStreamConfig} from '../src/types.js';

const ERC20_ABI = [
	{
		type: 'event',
		name: 'Transfer',
		inputs: [
			{indexed: true, name: 'from', type: 'address'},
			{indexed: true, name: 'to', type: 'address'},
			{indexed: false, name: 'value', type: 'uint256'},
		],
	},
] as const satisfies Abi;

const TOKEN = '0x0000000000000000000000000000000000000abc' as const;
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as const;

const SOURCE: IndexingSource<typeof ERC20_ABI> = {
	chainId: '8453',
	contracts: [{abi: ERC20_ABI, address: TOKEN, startBlock: 100}],
};

function topicAddress(last: number): `0x${string}` {
	return `0x${'0'.repeat(63 - 2)}${last.toString(16).padStart(3, '0')}` as `0x${string}`;
}

function rawLog(blockNumber: number, logIndex: number, value: bigint) {
	return {
		blockNumber: `0x${blockNumber.toString(16)}`,
		blockHash: `0x${blockNumber.toString(16).padStart(64, '0')}`,
		transactionIndex: '0x0',
		removed: false,
		address: TOKEN,
		data: `0x${value.toString(16).padStart(64, '0')}`,
		topics: [TRANSFER_TOPIC, topicAddress(1), topicAddress(2)],
		transactionHash: `0x${(blockNumber * 100 + logIndex).toString(16).padStart(64, '0')}`,
		logIndex: `0x${logIndex.toString(16)}`,
		blockTimestamp: `0x${(1700000000 + blockNumber).toString(16)}`,
	};
}

/** A provider that answers `eth_getLogs` from a fixed set and counts the calls. */
function makeProvider(logs: ReturnType<typeof rawLog>[]) {
	const calls: {method: string; params?: any}[] = [];
	const provider = {
		async request(args: {method: string; params?: any}): Promise<any> {
			calls.push({method: args.method, params: args.params});
			if (args.method === 'eth_getLogs') {
				const from = parseInt(args.params[0].fromBlock.slice(2), 16);
				const to = parseInt(args.params[0].toBlock.slice(2), 16);
				return logs.filter((log) => {
					const blockNumber = parseInt(log.blockNumber.slice(2), 16);
					return blockNumber >= from && blockNumber <= to;
				});
			}
			if (args.method === 'eth_chainId') return '0x2105';
			throw new Error(`unexpected method ${args.method}`);
		},
	};
	return {provider: provider as any, calls};
}

/** Records what it was handed, so a replay can be asserted on batching as well as content. */
function recordingProcessor() {
	const batches: {events: LogEvent<Abi>[]; lastSync: LastSync<Abi>}[] = [];
	const processor: EventProcessor<Abi, number> = {
		getVersionHash: () => 'v1',
		getCodeFingerprint: () => undefined,
		load: async () => undefined,
		process: async (eventStream, lastSync) => {
			batches.push({events: eventStream, lastSync});
			return batches.length;
		},
		reset: async () => {},
		clear: async () => {},
	};
	return {processor, batches};
}

const STREAM_CONFIG: UsedStreamConfig = {finality: 12};

describe('captureStream', () => {
	it('captures a decoded stream with provenance, and refuses an open-ended upper bound', async () => {
		const {provider, calls} = makeProvider([rawLog(100, 0, 1n), rawLog(100, 1, 2n), rawLog(105, 0, 3n)]);

		const fixture = await captureStream(provider, SOURCE, {
			toBlock: 110,
			provenance: {contractsCommit: 'deadbeef'},
		});

		expect(fixture.format).toBe(STREAM_FIXTURE_FORMAT);
		expect(fixture.eventStream.length).toBe(3);
		expect((fixture.eventStream[0] as any).eventName).toBe('Transfer');
		expect((fixture.eventStream[0] as any).args.value).toBe(1n);
		expect(fixture.provenance.chainId).toBe('8453');
		expect(fixture.provenance.fromBlock).toBe(100);
		expect(fixture.provenance.toBlock).toBe(110);
		expect(fixture.provenance.contractsCommit).toBe('deadbeef');
		expect(fixture.lastSync.lastToBlock).toBe(110);
		expect(calls.every((call) => call.method === 'eth_getLogs')).toBe(true);

		await expect(captureStream(provider, SOURCE, {toBlock: NaN})).rejects.toThrow(/numeric toBlock/);
	});
});

describe('a serialized fixture', () => {
	it('round-trips BigInt arguments, and refuses a shape it does not know', async () => {
		const {provider} = makeProvider([rawLog(100, 0, 2n ** 200n)]);
		const fixture = await captureStream(provider, SOURCE, {toBlock: 100});

		const parsed = parseStreamFixture<typeof ERC20_ABI>(serializeStreamFixture(fixture, 2));

		expect((parsed.eventStream[0] as any).args.value).toBe(2n ** 200n);
		expect(parsed.source.chainId).toBe(fixture.source.chainId);
		expect(parsed.lastSync).toEqual(fixture.lastSync);

		expect(() => parseStreamFixture('{"format":99}')).toThrow(/unsupported stream fixture format/);
		expect(() => parseStreamFixture('{"format":1}')).toThrow(/missing source/);
	});
});

describe('replayStream', () => {
	it('serves the captured events from a block, and refuses another chain', async () => {
		const {provider} = makeProvider([rawLog(100, 0, 1n), rawLog(105, 0, 2n), rawLog(110, 0, 3n)]);
		const fixture = await captureStream(provider, SOURCE, {toBlock: 110});

		const stream = replayStream(fixture);
		const fromTip = await stream.fetchFrom(SOURCE, 105);
		expect(fromTip?.eventStream.map((event) => event.blockNumber)).toEqual([105, 110]);

		// A fixture is a snapshot: writing through it must not change what it serves.
		await stream.saveNewEvents(SOURCE, {lastSync: fixture.lastSync, eventStream: []});
		expect((await stream.fetchFrom(SOURCE, 0))?.eventStream.length).toBe(3);

		await expect(stream.fetchFrom({...SOURCE, chainId: '1'}, 0)).rejects.toThrow(/chain/);
	});
});

describe('replayFixtureInto', () => {
	it('applies one block per process call, in order, with no node in the loop', async () => {
		const {provider} = makeProvider([rawLog(100, 0, 1n), rawLog(100, 1, 2n), rawLog(105, 0, 3n)]);
		const fixture = await captureStream(provider, SOURCE, {toBlock: 110});
		const {processor, batches} = recordingProcessor();

		const seen: number[] = [];
		const lastSync = await replayFixtureInto(processor as any, fixture, STREAM_CONFIG, {
			onBlock: (block) => {
				seen.push(block.number);
			},
		});

		expect(seen).toEqual([100, 105]);
		expect(batches.map((batch) => batch.events.length)).toEqual([2, 1]);
		expect(batches.map((batch) => batch.lastSync.lastToBlock)).toEqual([100, 105]);
		// 'live' (the default) means the block being applied IS the tip, so a
		// processor keeps whatever history its reorg path keeps.
		expect(batches.map((batch) => batch.lastSync.latestBlock)).toEqual([100, 105]);
		expect(lastSync.lastToBlock).toBe(105);

		const {processor: second, batches: finalBatches} = recordingProcessor();
		await replayFixtureInto(second as any, fixture, STREAM_CONFIG, {chainTip: 'final'});
		expect(finalBatches.map((batch) => batch.lastSync.latestBlock)).toEqual([110, 110]);
	});

	it('groups blocks by hash, keeping stream order and the block timestamp', async () => {
		const {provider} = makeProvider([rawLog(100, 0, 1n), rawLog(100, 1, 2n), rawLog(105, 0, 3n)]);
		const fixture = await captureStream(provider, SOURCE, {toBlock: 110});

		const blocks = blocksOf(fixture);
		expect(blocks.map((block) => block.number)).toEqual([100, 105]);
		expect(blocks[0].events.length).toBe(2);
		expect(blocks[0].timestamp).toBe(1700000100);
	});
});

describe('a fixture replayed twice', () => {
	it('produces the same input both times', async () => {
		const {provider} = makeProvider([rawLog(100, 0, 1n), rawLog(105, 0, 2n)]);
		const fixture: StreamFixture<typeof ERC20_ABI> = await captureStream(provider, SOURCE, {toBlock: 110});
		const text = serializeStreamFixture(fixture);

		const first = recordingProcessor();
		const second = recordingProcessor();
		await replayFixtureInto(first.processor as any, parseStreamFixture(text), STREAM_CONFIG);
		await replayFixtureInto(second.processor as any, parseStreamFixture(text), STREAM_CONFIG);

		expect(serializeStreamFixture({...fixture, eventStream: first.batches.flatMap((b) => b.events)} as any)).toBe(
			serializeStreamFixture({...fixture, eventStream: second.batches.flatMap((b) => b.events)} as any),
		);
	});
});
