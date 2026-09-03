import type {Abi} from 'abitype';
import {beforeEach, describe, expect, it} from 'vitest';
import {IndexerGeneration} from '../src/indexer.js';
import {InvalidBatchError, UnexpectedFromBlockError, WireContextMismatchError} from '../src/errors.js';
import {StreamBuilder, parseWireBatch, serializeWireBatch} from '../src/streamBuilder.js';
import type {EventProcessor, IndexingSource, LastSync, LogEvent, WireBatch} from '../src/types.js';

// ---------------------------------------------------------------------------
// THE RECEIVING SIDE OF THE WIRE (ADR-0004)
// ---------------------------------------------------------------------------
// `StreamBuilder` is the half of the split deployment that owns the cursor: it
// holds no provider, derives every reorg itself, and refuses a batch that does
// not start where it says it must. What is asserted here is the CONTRACT, and
// in particular the two properties an HTTP layer on top can only preserve, never
// create:
//
//   1. a batch starting anywhere but `expectedFromBlock` applies NOTHING, and
//   2. the stream it derives is the SAME one `IndexerGeneration` derives from the
//      same logs, because both go through `generateStreamToAppend`.
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

type TestABI = typeof abi;

const CONTRACT = '0x0000000000000000000000000000000000000099' as const;
const START_BLOCK = 100;
const FINALITY = 3;

const SOURCE: IndexingSource<TestABI> = {
	chainId: '1',
	contracts: [{abi, address: CONTRACT, startBlock: START_BLOCK}],
};

let logCounter = 0;

function transfer(blockNumber: number, blockHash: string, id: bigint, logIndex = 0): LogEvent<TestABI> {
	logCounter++;
	return {
		blockNumber,
		blockHash: blockHash as `0x${string}`,
		blockTimestamp: 1_700_000_000 + blockNumber * 12,
		transactionIndex: 0,
		removed: false,
		address: CONTRACT,
		data: '0x',
		topics: [],
		transactionHash: `0x${logCounter.toString(16).padStart(64, '0')}` as `0x${string}`,
		logIndex,
		extra: undefined,
		eventName: 'Transfer',
		args: {from: CONTRACT, to: CONTRACT, id},
	} as unknown as LogEvent<TestABI>;
}

/**
 * An `EventProcessor` that keeps its cursor in memory and records every stream
 * it is handed.
 *
 * It is the smallest thing that can play the part: the builder only ever asks it
 * for a persisted cursor and hands it a stream, so anything more would be
 * asserting a store rather than the wire.
 */
function recordingProcessor(versionHash = 'v1') {
	const streams: LogEvent<TestABI>[][] = [];
	let stored: LastSync<TestABI> | undefined;
	let cleared = 0;
	const processor: EventProcessor<TestABI, void> = {
		getVersionHash: () => versionHash,
		getCodeFingerprint: () => undefined,
		load: async () => (stored ? {state: undefined as void, lastSync: stored} : undefined),
		process: async (eventStream, lastSync) => {
			streams.push(eventStream);
			stored = lastSync;
		},
		reset: async () => {
			streams.length = 0;
			stored = undefined;
			cleared++;
		},
		clear: async () => processor.reset(),
	};
	return {
		processor,
		streams,
		get cleared() {
			return cleared;
		},
		get lastSync() {
			return stored;
		},
		set lastSync(value: LastSync<TestABI> | undefined) {
			stored = value;
		},
		/** Every event ever handed over, in order: the derived stream, concatenated. */
		flat: () => streams.flat(),
	};
}

function builderOn(processor: EventProcessor<TestABI, void>): StreamBuilder<TestABI, void> {
	return new StreamBuilder(processor, SOURCE, {stream: {finality: FINALITY}});
}

function batch(
	builder: StreamBuilder<TestABI, void>,
	over: Partial<WireBatch<TestABI>> & Pick<WireBatch<TestABI>, 'fromBlock' | 'toBlock' | 'latestBlock'>,
): WireBatch<TestABI> {
	return {context: builder.context, logs: [], ...over};
}

describe('the receiver owns the cursor', () => {
	let target: ReturnType<typeof recordingProcessor>;
	let builder: StreamBuilder<TestABI, void>;

	beforeEach(() => {
		target = recordingProcessor();
		builder = builderOn(target.processor);
	});

	it('expects the source start block before anything has been indexed', async () => {
		expect(await builder.expectedFromBlock()).toBe(START_BLOCK);
	});

	it('applies a batch starting exactly there, advancing state and the cursor together', async () => {
		const result = await builder.receive(
			batch(builder, {fromBlock: 100, toBlock: 105, latestBlock: 105, logs: [transfer(102, '0xa102', 1n)]}),
		);

		expect(result.applied).toBe(1);
		expect(result.retracted).toBe(0);
		expect(target.flat()).toHaveLength(1);
		expect(target.lastSync?.lastToBlock).toBe(105);
		// the next one must re-scan the unconfirmed window: latestBlock - finality
		expect(result.expectedFromBlock).toBe(102);
		expect(await builder.expectedFromBlock()).toBe(102);
	});

	it('refuses a batch starting anywhere else, applying nothing', async () => {
		await builder.receive(batch(builder, {fromBlock: 100, toBlock: 105, latestBlock: 105}));

		const gap = batch(builder, {fromBlock: 106, toBlock: 110, latestBlock: 110, logs: [transfer(107, '0xa107', 9n)]});
		await expect(builder.receive(gap)).rejects.toBeInstanceOf(UnexpectedFromBlockError);

		const before = target.lastSync;
		await builder.receive(gap).catch((err: UnexpectedFromBlockError) => {
			expect(err.expectedFromBlock).toBe(102);
			expect(err.receivedFromBlock).toBe(106);
		});
		// nothing moved: the cursor is where the refusal said it was
		expect(target.lastSync).toEqual(before);
		expect(target.flat()).toHaveLength(0);
	});

	it('refuses a re-sent batch rather than applying it twice, which is why there is no dedupe table', async () => {
		const first = batch(builder, {
			fromBlock: 100,
			toBlock: 105,
			latestBlock: 105,
			logs: [transfer(102, '0xa102', 1n)],
		});
		await builder.receive(first);
		expect(target.flat()).toHaveLength(1);

		// the acknowledgement was lost and the fetcher re-sent: the cursor IS the
		// idempotency key, so this fails the check and is corrected
		const err = await builder.receive(first).catch((e) => e);
		expect(err).toBeInstanceOf(UnexpectedFromBlockError);
		expect(err.expectedFromBlock).toBe(102);
		expect(target.flat()).toHaveLength(1);
	});

	it('is refused by the underlying primitive too, so the two cannot drift apart', async () => {
		// `expectedFromBlock` and `generateStreamToAppend` both read `getFromBlock`,
		// and this is what pins that they are the same answer: the builder's refusal
		// is not a second, parallel check that could disagree with the engine's.
		await builder.receive(batch(builder, {fromBlock: 100, toBlock: 105, latestBlock: 105}));
		const expected = await builder.expectedFromBlock();

		const indexer = new IndexerGeneration<TestABI, void>(noChain(), recordingProcessor().processor, SOURCE, {
			stream: {finality: FINALITY},
		});
		await indexer.feed([], {
			context: {source: builder.context.source, config: builder.context.config, processor: 'v1'},
			latestBlock: 105,
			lastFromBlock: START_BLOCK,
			lastToBlock: 105,
			unconfirmedBlocks: [],
		});
		expect(indexer.expectedFromBlock).toBe(expected);
	});
});

describe('the context is validated on every batch', () => {
	it('refuses a batch belonging to another source, loudly and distinctly', async () => {
		const target = recordingProcessor();
		const builder = builderOn(target.processor);

		const foreign = {
			...batch(builder, {fromBlock: 100, toBlock: 105, latestBlock: 105, logs: [transfer(101, '0xa101', 1n)]}),
			context: {source: [{startBlock: 0, hash: 'someone-elses'}], config: builder.context.config},
		};
		const err = await builder.receive(foreign).catch((e) => e);
		expect(err).toBeInstanceOf(WireContextMismatchError);
		// distinct from the cursor refusal, which a sender RECOVERS from by re-sending
		expect(err).not.toBeInstanceOf(UnexpectedFromBlockError);
		expect(target.flat()).toHaveLength(0);
	});

	it('refuses a batch belonging to another stream config', async () => {
		const target = recordingProcessor();
		const builder = builderOn(target.processor);
		const foreign = {
			...batch(builder, {fromBlock: 100, toBlock: 105, latestBlock: 105}),
			context: {source: builder.context.source, config: 'someone-elses'},
		};
		await expect(builder.receive(foreign)).rejects.toBeInstanceOf(WireContextMismatchError);
	});

	it('checks the context BEFORE the cursor, so a foreign batch is never told to resume', async () => {
		const target = recordingProcessor();
		const builder = builderOn(target.processor);
		const foreign = {
			...batch(builder, {fromBlock: 999, toBlock: 1000, latestBlock: 1000}),
			context: {source: builder.context.source, config: 'someone-elses'},
		};
		await expect(builder.receive(foreign)).rejects.toBeInstanceOf(WireContextMismatchError);
	});

	it('discards a persisted cursor that belongs to another source, instead of resuming on top of it', async () => {
		// the hole `docs/reviews/todo-triage.md` found in every persistence layer:
		// a stored `lastSync` adopted without checking whose it is.
		const target = recordingProcessor();
		target.lastSync = {
			context: {source: [{startBlock: 0, hash: 'another-source'}], config: 'another-config', processor: 'v1'},
			latestBlock: 5000,
			lastFromBlock: 4000,
			lastToBlock: 5000,
			unconfirmedBlocks: [],
		};
		const builder = builderOn(target.processor);

		expect(await builder.expectedFromBlock()).toBe(START_BLOCK);
		expect(target.cleared).toBe(1);
	});

	it('discards a persisted cursor written by another processor version', async () => {
		const target = recordingProcessor('v2');
		const builder = builderOn(target.processor);
		await builder.receive(batch(builder, {fromBlock: 100, toBlock: 105, latestBlock: 105}));
		expect(await builder.expectedFromBlock()).toBe(102);

		// same source and config, different processor: the state means something else
		const upgraded = new StreamBuilder<TestABI, void>({...target.processor, getVersionHash: () => 'v3'}, SOURCE, {
			stream: {finality: FINALITY},
		});
		expect(await upgraded.expectedFromBlock()).toBe(START_BLOCK);
		expect(target.cleared).toBe(1);
	});
});

describe('the envelope is checked before anything is applied', () => {
	let target: ReturnType<typeof recordingProcessor>;
	let builder: StreamBuilder<TestABI, void>;

	beforeEach(() => {
		target = recordingProcessor();
		builder = builderOn(target.processor);
	});

	it('refuses a range that runs backwards', async () => {
		await expect(
			builder.receive(batch(builder, {fromBlock: 100, toBlock: 99, latestBlock: 105})),
		).rejects.toBeInstanceOf(InvalidBatchError);
	});

	it('refuses a range claiming blocks above the chain tip it reports', async () => {
		await expect(
			builder.receive(batch(builder, {fromBlock: 100, toBlock: 110, latestBlock: 105})),
		).rejects.toBeInstanceOf(InvalidBatchError);
	});

	it('refuses a log outside the range it claims to cover', async () => {
		// completeness is an invariant, not a flag: a payload holds every log in
		// [fromBlock, toBlock] and nothing else, and truncation is a LOWER toBlock.
		const err = await builder
			.receive(batch(builder, {fromBlock: 100, toBlock: 105, latestBlock: 105, logs: [transfer(106, '0xa106', 1n)]}))
			.catch((e) => e);
		expect(err).toBeInstanceOf(InvalidBatchError);
		expect(target.flat()).toHaveLength(0);
	});

	it('refuses a log already marked removed: no reorg information crosses the wire', async () => {
		const removed = {...transfer(101, '0xa101', 1n), removed: true} as LogEvent<TestABI>;
		await expect(
			builder.receive(batch(builder, {fromBlock: 100, toBlock: 105, latestBlock: 105, logs: [removed]})),
		).rejects.toBeInstanceOf(InvalidBatchError);
	});
});

describe('reorgs are derived here, from raw logs alone', () => {
	async function upTo105(target: ReturnType<typeof recordingProcessor>, builder: StreamBuilder<TestABI, void>) {
		await builder.receive(
			batch(builder, {
				fromBlock: 100,
				toBlock: 105,
				latestBlock: 105,
				logs: [transfer(101, '0xa101', 1n), transfer(104, '0xa104', 2n)],
			}),
		);
		expect(target.flat()).toHaveLength(2);
	}

	it('reports a hash replacement as a CONTRADICTION and retracts the dead branch', async () => {
		const target = recordingProcessor();
		const builder = builderOn(target.processor);
		await upTo105(target, builder);

		const result = await builder.receive(
			batch(builder, {fromBlock: 102, toBlock: 106, latestBlock: 106, logs: [transfer(104, '0xb104', 3n)]}),
		);

		expect(result.reorg).toMatchObject({cause: 'contradiction', blockNumber: 104, blockHash: '0xa104'});
		expect(result.retracted).toBe(1);
		expect(result.applied).toBe(1);
	});

	it('reports a vanished block as an ABSENCE, which is an inference and not proof', async () => {
		const target = recordingProcessor();
		const builder = builderOn(target.processor);
		await upTo105(target, builder);

		// the re-fetched range simply does not contain block 104 any more
		const result = await builder.receive(batch(builder, {fromBlock: 102, toBlock: 106, latestBlock: 106, logs: []}));

		expect(result.reorg).toMatchObject({cause: 'absence', blockNumber: 104, blockHash: '0xa104'});
		expect(result.retracted).toBe(1);
		expect(result.applied).toBe(0);
	});

	it('derives the SAME stream the engine derives from the same logs', async () => {
		// ADR-0004's reason for keeping reorg logic on one side: the receiver must
		// reach the engine's answer, not its own approximation of it. Both paths go
		// through `generateStreamToAppend`, and this is what pins that they do.
		const viaWire = recordingProcessor();
		const builder = builderOn(viaWire.processor);
		const viaEngine = recordingProcessor();
		const indexer = new IndexerGeneration<TestABI, void>(noChain(), viaEngine.processor, SOURCE, {
			stream: {finality: FINALITY},
		});

		const rounds: {fromBlock: number; toBlock: number; latestBlock: number; logs: LogEvent<TestABI>[]}[] = [
			{
				fromBlock: 100,
				toBlock: 105,
				latestBlock: 105,
				logs: [transfer(101, '0xa101', 1n), transfer(104, '0xa104', 2n)],
			},
			{fromBlock: 102, toBlock: 106, latestBlock: 106, logs: [transfer(104, '0xb104', 3n)]},
			{fromBlock: 103, toBlock: 108, latestBlock: 108, logs: [transfer(104, '0xb104', 3n)]},
		];

		for (const round of rounds) {
			await builder.receive(batch(builder, round));
			await indexer.feed(round.logs, {
				context: {source: builder.context.source, config: builder.context.config, processor: 'v1'},
				latestBlock: round.latestBlock,
				lastFromBlock: round.fromBlock,
				lastToBlock: round.toBlock,
				unconfirmedBlocks: [],
			});
		}

		const identity = (events: LogEvent<TestABI>[]) =>
			events.map((e) => `${e.removed ? '-' : '+'}${e.blockNumber}:${e.blockHash}:${e.transactionHash}`);
		expect(identity(viaWire.flat())).toEqual(identity(viaEngine.flat()));
	});
});

describe('the wire codec', () => {
	it('round-trips a batch whose event arguments are BigInts', () => {
		const target = recordingProcessor();
		const builder = builderOn(target.processor);
		const original = batch(builder, {
			fromBlock: 100,
			toBlock: 105,
			latestBlock: 105,
			logs: [transfer(101, '0xa101', 2n ** 200n)],
		});

		const revived = parseWireBatch<TestABI>(serializeWireBatch(original));
		expect(revived).toEqual(original);
		expect((revived.logs[0] as {args: {id: bigint}}).args.id).toBe(2n ** 200n);
	});

	it('leaves a string that merely LOOKS like a BigInt literal alone', () => {
		// the `"123n"` suffix convention has to guess, and a contract can emit a
		// string ending in `n`. The tag cannot be produced by accident.
		const target = recordingProcessor();
		const builder = builderOn(target.processor);
		const log = transfer(101, '0xa101', 1n) as unknown as {args: {from: string}};
		log.args.from = '123n';
		const original = batch(builder, {
			fromBlock: 100,
			toBlock: 105,
			latestBlock: 105,
			logs: [log as unknown as LogEvent<TestABI>],
		});

		const revived = parseWireBatch<TestABI>(serializeWireBatch(original));
		expect((revived.logs[0] as unknown as {args: {from: unknown}}).args.from).toBe('123n');
	});
});

/**
 * A provider that refuses every call.
 *
 * The receiving half has no chain (ADR-0003 keeps every chain call in the
 * log-fetcher), and `feed()` is the one `IndexerGeneration` entry point that makes
 * none. Handing it a refusing provider is how that stays true.
 */
function noChain() {
	return {
		async request(args: {method: string}): Promise<never> {
			throw new Error(`the receiving side called ${args.method}: it has no chain`);
		},
	} as never;
}
