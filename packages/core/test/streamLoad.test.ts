import {describe, expect, it} from 'vitest';
import {
	fakeChain,
	fakeProcessor,
	idOf,
	indexToTip,
	makeIndexer,
	makeLog,
	memoryStream,
	START_BLOCK,
	type ProcessorStore,
} from './utils/streamCacheWorld.js';

// ---------------------------------------------------------------------------
// A STREAM AHEAD OF THE STATE IS REPLAYED, NOT RE-FETCHED
// ---------------------------------------------------------------------------
// Once the stream is written BEFORE the processor runs, the reachable divergence
// is "stream ahead of state": the write lands and then `process` throws, or the
// tab is closed between the two awaits, which in a browser is ordinary rather
// than exotic.
//
// That direction is supposed to be benign because the processor just catches up.
// The state-DISCARDED load branch did exactly that; the state-KEPT branch only
// validated the stream and never fed it, so the state caught up from the NODE
// instead and those blocks were appended to the stream a SECOND time. On the
// next rebuild the processor saw them twice.
// ---------------------------------------------------------------------------

/** Logs spread far enough apart that the finality re-scan is visible in the ranges. */
const LOGS = [makeLog(100, '0xa100'), makeLog(102, '0xa102'), makeLog(104, '0xa104')];
const LATER = [makeLog(106, '0xa106'), makeLog(108, '0xa108')];

/**
 * Index to block 105 with both stores, then let the tab die between the two
 * writes: the stream write for 106..109 lands and `process` never returns.
 *
 * The processor persists inside `process()`, so a `process` that throws writes
 * no cursor -- which is what the tab going away does, without a mock of death.
 */
async function stateBehindStream() {
	const store: ProcessorStore = {};
	const stream = memoryStream();
	const chain = fakeChain([...LOGS], 105);
	const first = fakeProcessor(store);
	const indexer = makeIndexer(chain, first.processor, stream.keeper);
	await indexer.load();
	await indexToTip(indexer);

	chain.serve([...LOGS, ...LATER], 109);
	first.throwOnProcess(true);
	await expect(indexer.indexMore()).rejects.toThrow('processor blew up');

	// the stream holds 106 and 108; the state's cursor is still at 105
	expect(stream.events.map(idOf)).toEqual([...LOGS, ...LATER].map(idOf));
	expect(store.saved?.lastSync.lastToBlock).toBe(105);
	return {store, stream, chain};
}

describe('a stream ahead of the state, with the state KEPT', () => {
	it('is REPLAYED rather than re-fetched, and the state catches up to its cursor', async () => {
		const {store, stream} = await stateBehindStream();

		const chain = fakeChain([...LOGS, ...LATER], 109);
		const reloaded = fakeProcessor(store);
		const indexer = makeIndexer(chain, reloaded.processor, stream.keeper);
		const lastSync = await indexer.load();

		// the state caught up to where the stream reaches...
		expect(lastSync.lastToBlock).toBe(109);
		expect(reloaded.state).toEqual([...LOGS, ...LATER].map(idOf));
		// ...out of the cache: the node was asked for nothing at all during load
		expect(chain.ranges).toHaveLength(0);
		expect(stream.clears).toBe(0);

		// and indexing on asks only for what the stream did not hold
		await indexToTip(indexer);
		for (const range of chain.ranges) {
			expect(range.from).toBeGreaterThan(105);
		}
	});

	it('leaves no duplicate: the events the stream already held are not appended twice', async () => {
		const {store, stream} = await stateBehindStream();

		const chain = fakeChain([...LOGS, ...LATER], 109);
		const reloaded = fakeProcessor(store);
		const indexer = makeIndexer(chain, reloaded.processor, stream.keeper);
		await indexer.load();
		await indexToTip(indexer);

		const ids = stream.events.map(idOf);
		expect(ids).toEqual([...new Set(ids)]);
		expect(ids).toEqual([...LOGS, ...LATER].map(idOf));
	});

	it('lands on the state a from-scratch index lands on, which is the equality that used to fail', async () => {
		const {store, stream} = await stateBehindStream();

		const chain = fakeChain([...LOGS, ...LATER], 109);
		const reloaded = fakeProcessor(store);
		const indexer = makeIndexer(chain, reloaded.processor, stream.keeper);
		await indexer.load();
		await indexToTip(indexer);

		const scratchChain = fakeChain([...LOGS, ...LATER], 109);
		const scratch = fakeProcessor({});
		const scratchIndexer = makeIndexer(scratchChain, scratch.processor);
		await scratchIndexer.load();
		await indexToTip(scratchIndexer);

		expect(reloaded.state).toEqual(scratch.state);
	});

	it('does not feed, and does not clear, a stream that is BEHIND the state', async () => {
		// the frozen-cache shape: a contiguous prefix that the state has run past.
		// It is a usable partial seed, so it is kept exactly as it is.
		const store: ProcessorStore = {};
		const stream = memoryStream();
		const chain = fakeChain([...LOGS], 105);
		const subject = fakeProcessor(store);
		const indexer = makeIndexer(chain, subject.processor, stream.keeper, {
			maxConsecutiveFailures: 1,
			delaySeconds: 0,
		});
		await indexer.load();
		await indexToTip(indexer);
		const prefix = stream.events.map(idOf);

		stream.failEvery(() => new Error('the store is broken'));
		chain.serve([...LOGS, ...LATER], 109);
		await indexToTip(indexer);
		expect(store.saved?.lastSync.lastToBlock).toBe(109);

		stream.succeed();
		const reloadChain = fakeChain([...LOGS, ...LATER], 109);
		const reloaded = fakeProcessor(store);
		const reloadedIndexer = makeIndexer(reloadChain, reloaded.processor, stream.keeper);
		await reloadedIndexer.load();

		expect(stream.clears).toBe(0);
		expect(stream.events.map(idOf)).toEqual(prefix);
		expect(reloaded.state).toEqual([...LOGS, ...LATER].map(idOf));
	});
});

describe('a stream holding a CURSOR and no events', () => {
	/**
	 * A deployment whose contracts have emitted nothing yet, with a stream keeper
	 * and NO state keeper -- the only shape where resumption depends on the
	 * stream's cursor, because with a state keeper the state's cursor carries it.
	 */
	async function scanFrom(stream: ReturnType<typeof memoryStream>, tip: number) {
		const chain = fakeChain([], tip);
		const processor = fakeProcessor({}, {persist: false});
		const indexer = makeIndexer(chain, processor.processor, stream.keeper);
		await indexer.load();
		await indexToTip(indexer);
		return chain.ranges;
	}

	it('resumes from that cursor rather than from the start block, and keeps advancing across reloads', async () => {
		const stream = memoryStream();

		const first = await scanFrom(stream, 200);
		expect(first[0].from).toBe(START_BLOCK);
		expect(stream.cursor?.lastToBlock).toBe(200);
		expect(stream.events).toHaveLength(0);

		// a second tab, the same store: the cursor is adopted rather than ignored
		const second = await scanFrom(stream, 300);
		expect(second[0].from).toBeGreaterThan(START_BLOCK);
		expect(stream.cursor?.lastToBlock).toBe(300);

		// and it keeps ADVANCING: a keeper that re-scanned from the start block on
		// every reload would look identical on the run above and fail here
		const third = await scanFrom(stream, 400);
		expect(third[0].from).toBeGreaterThan(second[0].from);
		expect(stream.cursor?.lastToBlock).toBe(400);
		expect(stream.clears).toBe(0);
	});
});
