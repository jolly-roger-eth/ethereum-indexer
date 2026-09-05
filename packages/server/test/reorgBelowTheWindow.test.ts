import type {RemoteSQL} from 'remote-sql';
import {beforeEach, describe, expect, it} from 'vitest';
import {clearLastError} from '../src/api/status.js';
import {
	ALICE,
	BOB,
	CAROL,
	SOURCE,
	STREAM_DIGEST,
	batchOf,
	deploy,
	post,
	readCanonical as readCanonicalPage,
	readFeed as readFeedPage,
	transfer,
	type Deployment,
	type TestABI,
} from './utils/feedHarness.js';
import type {LogEvent} from '@etherfold/core';

// ---------------------------------------------------------------------------
// A FORK BELOW THE LOWEST BLOCK WE HELD LOGS FOR, END TO END
// ---------------------------------------------------------------------------
// The engine's unconfirmed window holds only EVENT-BEARING blocks, so it is
// SPARSE, and the chain does not fork where our logs happen to be. The defect
// this pins is what that combination used to cost: on a concluded reorg the fold
// admitted an incoming block only at or above the height it reverted at, so
// every log the replacement branch carried BELOW that height -- inside the very
// range that was re-fetched -- was dropped in memory and never fetched again,
// because the next range starts above it. Silent, permanent loss.
//
// It is asserted HERE, and not only at `generateStreamToAppend` in
// `@etherfold/core`, because the util's return value is not what anybody reads.
// What a consumer reads is the STORED emission stream and the two views over it
// (ADR-0006), and a log that never reaches the table is not a log anyone can
// act on later. So the reorg is driven through `/{indexer}/ingest`, exactly as a
// fetcher delivers one: the stream-builder derives the reorg itself, the route
// writes the rows, and the fold runs -- a batch this size failing anywhere in
// that chain comes back as a non-200 and `post` refuses to carry on.
//
// The once-only half is asserted just as hard, because the height comparison
// that was removed was also what stopped a re-offered block being applied twice:
// every cycle re-reads the last `finality` blocks, so a rule that admits too
// much duplicates state as reliably as the old one lost it.
// ---------------------------------------------------------------------------

type FeedEntry = {removed: boolean; blockNumber: number; blockHash: string};
type CanonicalEntry = {blockNumber: number; blockHash: string};

type Row = {seq: number; blockNumber: number; blockHash: string; removed: number; alive: number};

/** Every stored emission, in `seq` order, which is the order the feed reads them. */
async function emissions(db: RemoteSQL): Promise<Row[]> {
	return (
		await db
			.prepare(`SELECT seq, blockNumber, blockHash, removed, alive FROM EmissionStream WHERE stream = ?1 ORDER BY seq`)
			.bind(STREAM_DIGEST)
			.all<Row>()
	).results;
}

async function readFeed(deployment: Deployment): Promise<FeedEntry[]> {
	const page = await readFeedPage<{entries: FeedEntry[]}>(deployment, 'alpha');
	return page.body.entries;
}

/**
 * The canonical view's entries, projected to the two fields this suite is about.
 * An entry carries the whole log; WHICH BLOCKS a gated read answers with is what
 * the gap costs, and the rest of the shape is the view's own suite's business.
 */
async function readCanonical(deployment: Deployment, gate: number): Promise<[number, string][]> {
	const page = await readCanonicalPage<{entries: CanonicalEntry[]}>(deployment, 'alpha', {gate});
	return page.body.entries.map((entry) => [entry.blockNumber, entry.blockHash]);
}

describe('a fork below the lowest block we held logs for', () => {
	let deployment: Deployment;
	// the replacement branch, held as objects so a later batch can re-offer the
	// IDENTICAL logs: a re-fetch returns the same bytes, not look-alikes
	let gapLog: LogEvent<TestABI>;
	let replacementLog: LogEvent<TestABI>;

	beforeEach(async () => {
		clearLastError();
		deployment = await deploy({alpha: SOURCE});
		// ONE event-bearing block, at 105. Blocks 100..104 carried no logs for this
		// filter, so the window holds nothing there -- which is the ordinary case and
		// not a contrived one.
		await post(deployment, 'alpha', batchOf(deployment, 'alpha', 100, 105, 105, [transfer(105, '0xa105', ALICE, 1n)]));
		// The chain forked at 103, where we held nothing. The re-fetch (which must
		// start at `latestBlock - finality` = 102) carries the new branch's log at
		// 103, in the gap, and the replacement at 105.
		gapLog = transfer(103, '0xb103', BOB, 2n);
		replacementLog = transfer(105, '0xb105', CAROL, 3n);
	});

	it('stores the gap log in the emission stream, beside the retraction it arrived with', async () => {
		await post(deployment, 'alpha', batchOf(deployment, 'alpha', 102, 106, 106, [gapLog, replacementLog]));

		expect(
			(await emissions(deployment.db)).map((row) => [row.seq, row.blockNumber, row.blockHash, row.removed, row.alive]),
		).toEqual([
			// the block we held, still here and flagged dead rather than deleted
			[1, 105, '0xa105', 0, 0],
			// its retraction
			[2, 105, '0xa105', 1, 0],
			// THE POINT: the new branch's log BELOW the height the fold reverted at.
			// This row did not exist before the window-membership rule: it was fetched,
			// dropped, and the next range started at 103's successor.
			[3, 103, '0xb103', 0, 1],
			[4, 105, '0xb105', 0, 1],
		]);
	});

	it('serves it on the retraction-aware feed, in stream order', async () => {
		await post(deployment, 'alpha', batchOf(deployment, 'alpha', 102, 106, 106, [gapLog, replacementLog]));

		expect((await readFeed(deployment)).map((entry) => [entry.removed, entry.blockNumber, entry.blockHash])).toEqual([
			[false, 105, '0xa105'],
			[true, 105, '0xa105'],
			[false, 103, '0xb103'],
			[false, 105, '0xb105'],
		]);
	});

	it('serves it on the canonical view, in block order', async () => {
		await post(deployment, 'alpha', batchOf(deployment, 'alpha', 102, 106, 106, [gapLog, replacementLog]));

		// a consumer that never hears the word reorg still gets the whole canonical
		// branch, gap included, which is the answer that was silently short
		expect(await readCanonical(deployment, 106)).toEqual([
			[103, '0xb103'],
			[105, '0xb105'],
		]);
	});

	it('applies it ONCE, however many times the re-fetch re-offers it', async () => {
		await post(deployment, 'alpha', batchOf(deployment, 'alpha', 102, 106, 106, [gapLog, replacementLog]));
		const afterTheFork = await emissions(deployment.db);

		// The next cycle re-reads the finality window and re-offers both blocks under
		// the hashes the window now holds. Both are already applied, so the batch is
		// accepted and appends NOTHING: this is the job the removed height comparison
		// was doing, and the window-membership test has to keep doing it.
		await post(deployment, 'alpha', batchOf(deployment, 'alpha', 103, 107, 107, [gapLog, replacementLog]));

		expect(await emissions(deployment.db)).toEqual(afterTheFork);
		expect(await readCanonical(deployment, 107)).toEqual([
			[103, '0xb103'],
			[105, '0xb105'],
		]);
	});
});
