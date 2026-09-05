import {createClient} from '@libsql/client';
import {RemoteLibSQL} from 'remote-sql-libsql';
import type {RemoteSQL} from 'remote-sql';
import {beforeEach, describe, expect, it} from 'vitest';
import {createServer} from '../src/index.js';
import {clearLastError} from '../src/api/status.js';
import {decodeFeedCursor, encodeFeedCursor, STREAM_FEED_VIEW} from '../src/feed/cursor.js';
import {
	ALICE,
	BOB,
	CAROL,
	CONTRACT,
	IDENTICAL_SOURCE,
	OTHER_CONTRACT,
	RECONFIGURED_DIGEST,
	RECONFIGURED_SOURCE,
	SOURCE,
	STREAM_DIGEST,
	TOKEN,
	TRANSFER_TOPIC0,
	ZERO,
	batchOf,
	deploy,
	pad,
	post,
	readFeed as read,
	transfer,
	type Deployment,
	type TestEnv,
} from './utils/feedHarness.js';

// ---------------------------------------------------------------------------
// THE RETRACTION-AWARE FEED (ADR-0006, the first of the two views)
// ---------------------------------------------------------------------------
// `GET /{indexer}/feed`: the stored emission stream in `seq` order, retractions
// INCLUDED, resumed from a cursor the CALLER holds. This is the view for a
// consumer that WANTS to see reorgs -- it acts optimistically on a log and
// cancels the pending action when the retraction arrives -- so nothing is
// filtered out of it.
//
// What is actually under test is the CURSOR, because it is the only part that
// can produce a plausible WRONG answer rather than an obvious failure:
//
//  - it is OPAQUE, so its encoding never becomes a contract (ADR-0027);
//  - it CARRIES the indexer name and the stream, and both are VALIDATED and
//    never used to route: the route already routed, and these copies exist so
//    that a cursor presented at the wrong indexer, or against a stream that is
//    no longer served, is REFUSED instead of answered at a number that means
//    something else there;
//  - HOLES in `seq` are LEGAL, so a consumer's next position is the `seq` it was
//    actually served and never that number plus one. Compaction will create the
//    holes later; this is what has to already be true when it does.
//
// The fixture (the ABI, the sources, `deploy`, `post`, `batchOf`) lives in
// `utils/feedHarness.ts`, shared with the canonical view's suite.
// ---------------------------------------------------------------------------

type FeedEntryShape = {
	removed: boolean;
	blockNumber: number;
	blockHash: string;
	logIndex: number;
	transactionHash: string;
	transactionIndex: number;
	blockTimestamp?: number;
	address: string;
	topics: string[];
	data: string;
};

/**
 * A feed response as a TEST reads it: the page's fields and the refusal's, in one
 * shape.
 *
 * Written as ONE type rather than a union because every assertion here already
 * knows which of the two it is looking at (it asserted the status first), and a
 * union would add a narrowing dance to each of them that proves nothing about
 * the server.
 */
type FeedBody = {
	success: boolean;
	stream: string;
	entries: FeedEntryShape[];
	cursor: string;
	hasMore: boolean;
	error?: string;
	indexer?: string;
	view?: string;
	maxLimit?: number;
	startCursor?: string;
};

/** The harness's reader, at this suite's idea of what a feed response holds. */
async function readFeed(
	deployment: Deployment,
	name: string,
	query: {cursor?: string; limit?: number | string} = {},
): Promise<{status: number; body: FeedBody; text: string}> {
	return read<FeedBody>(deployment, name, query);
}

/** Follow the feed to its end, one page at a time, exactly as a consumer would. */
async function follow(
	deployment: Deployment,
	name: string,
	limit: number,
): Promise<{entries: FeedEntryShape[]; pages: number; cursor: string}> {
	const entries: FeedEntryShape[] = [];
	let cursor: string | undefined;
	let pages = 0;
	// bounded so a STALL fails as a test rather than as a hang
	for (let guard = 0; guard < 50; guard++) {
		const page = await readFeed(deployment, name, {cursor, limit});
		expect(page.status).toBe(200);
		pages++;
		entries.push(...page.body.entries);
		// the caller holds the cursor and nothing else: no arithmetic on a position
		cursor = page.body.cursor;
		if (!page.body.hasMore) return {entries, pages, cursor};
	}
	throw new Error(`the feed never reported itself caught up: it stalled or repeated`);
}

/** What identifies ONE entry for "nothing skipped and nothing repeated". */
function identityOf(entry: FeedEntryShape): string {
	return `${entry.transactionHash}:${entry.blockHash}:${entry.logIndex}:${entry.removed ? 'retracted' : 'applied'}`;
}

// ---------------------------------------------------------------------------

describe('a consumer follows the stream across pages, skipping and repeating nothing', () => {
	let deployment: Deployment;

	beforeEach(async () => {
		clearLastError();
		deployment = await deploy({alpha: SOURCE});
		// two batches, with `latestBlock` far enough ahead that the second one starts
		// ABOVE the first's range: no block is re-scanned, so nothing is retracted and
		// this fixture is five plain applications
		await post(
			deployment,
			'alpha',
			batchOf(deployment, 'alpha', 100, 105, 120, [
				transfer(101, '0xa101', ALICE, 1n),
				transfer(102, '0xa102', BOB, 2n),
				transfer(103, '0xa103', CAROL, 3n, 1),
			]),
		);
		await post(
			deployment,
			'alpha',
			batchOf(deployment, 'alpha', 106, 110, 120, [
				transfer(107, '0xa107', ALICE, 4n),
				transfer(109, '0xa109', BOB, 5n),
			]),
		);
	});

	it('serves an ordered first page and resumes exactly where it left off', async () => {
		const first = await readFeed(deployment, 'alpha', {limit: 2});
		expect(first.status).toBe(200);
		expect(first.body.entries.map((entry) => entry.blockNumber)).toEqual([101, 102]);
		expect(first.body.hasMore).toBe(true);

		const second = await readFeed(deployment, 'alpha', {cursor: first.body.cursor, limit: 2});
		expect(second.status).toBe(200);
		expect(second.body.entries.map((entry) => entry.blockNumber)).toEqual([103, 107]);

		const third = await readFeed(deployment, 'alpha', {cursor: second.body.cursor, limit: 2});
		expect(third.body.entries.map((entry) => entry.blockNumber)).toEqual([109]);
		expect(third.body.hasMore).toBe(false);
	});

	it('delivers every entry exactly once across pages of every size', async () => {
		const whole = await follow(deployment, 'alpha', 100);
		expect(whole.entries).toHaveLength(5);

		for (const limit of [1, 2, 3, 5]) {
			const paged = await follow(deployment, 'alpha', limit);
			expect(paged.entries.map(identityOf)).toEqual(whole.entries.map(identityOf));
			expect(new Set(paged.entries.map(identityOf)).size).toBe(paged.entries.length);
		}
	});

	it('keeps answering a caught-up cursor with an empty page rather than a refusal', async () => {
		const caughtUp = await follow(deployment, 'alpha', 2);

		const again = await readFeed(deployment, 'alpha', {cursor: caughtUp.cursor, limit: 2});
		expect(again.status).toBe(200);
		expect(again.body.entries).toEqual([]);
		expect(again.body.hasMore).toBe(false);

		// and a cursor is still handed back, so a poller keeps a valid one
		const resumed = await readFeed(deployment, 'alpha', {cursor: again.body.cursor, limit: 2});
		expect(resumed.status).toBe(200);
		expect(resumed.body.entries).toEqual([]);
	});

	it('carries the raw log the node reported, retraction verdict included', async () => {
		const page = await readFeed(deployment, 'alpha', {limit: 1});
		const [entry] = page.body.entries;

		expect(entry).toEqual({
			removed: false,
			blockNumber: 101,
			blockHash: '0xa101',
			logIndex: 0,
			transactionHash: expect.any(String),
			transactionIndex: 0,
			blockTimestamp: 1_700_000_000 + 101 * 12,
			address: CONTRACT,
			topics: [TRANSFER_TOPIC0, pad(ZERO), pad(ALICE)],
			data: `0x${1n.toString(16).padStart(64, '0')}`,
		});
	});
});

describe('retractions are DELIVERED, in seq order beside what they retract', () => {
	it('gives a consumer the apply, the retraction and the replacement', async () => {
		const deployment = await deploy({alpha: SOURCE});
		await post(
			deployment,
			'alpha',
			batchOf(deployment, 'alpha', 100, 105, 105, [
				transfer(101, '0xa101', ALICE, 1n),
				transfer(104, '0xa104', BOB, 2n),
			]),
		);
		// block 104 is replaced: the same height now carries 0xb104
		await post(deployment, 'alpha', batchOf(deployment, 'alpha', 102, 106, 106, [transfer(104, '0xb104', CAROL, 3n)]));

		const followed = await follow(deployment, 'alpha', 2);

		expect(followed.entries.map((entry) => [entry.blockNumber, entry.blockHash, entry.removed])).toEqual([
			[101, '0xa101', false],
			[104, '0xa104', false],
			// THE POINT of this view: the retraction ARRIVES, it is not filtered
			[104, '0xa104', true],
			[104, '0xb104', false],
		]);
	});

	it("does not filter on `alive`, which is the OTHER view's rule", async () => {
		const deployment = await deploy({alpha: SOURCE});
		await post(deployment, 'alpha', batchOf(deployment, 'alpha', 100, 105, 105, [transfer(104, '0xa104', BOB, 2n)]));
		await post(deployment, 'alpha', batchOf(deployment, 'alpha', 102, 106, 106, [transfer(104, '0xb104', CAROL, 3n)]));

		const alive = (
			await deployment.db.prepare(`SELECT COUNT(*) AS n FROM EmissionStream WHERE alive = 1`).all<{n: number}>()
		).results[0]?.n;
		expect(alive).toBe(1);

		const followed = await follow(deployment, 'alpha', 10);
		expect(followed.entries).toHaveLength(3);
	});
});

describe('HOLES in seq are legal and are followed to the end', () => {
	/**
	 * Compaction is a later task and this is what must already be true when it
	 * lands: it drops a retracted entry together with its retraction, which leaves
	 * the surrounding `seq` values exactly where they were. A consumer that
	 * derived its next position by INCREMENTING would stall on the first hole; one
	 * that carries the `seq` it was actually served does not.
	 */
	async function punch(db: RemoteSQL, seqs: number[]): Promise<void> {
		for (const seq of seqs) {
			await db.prepare(`DELETE FROM EmissionStream WHERE seq = ?1`).bind(seq).all();
		}
	}

	it('follows a stream whose seq values are not contiguous, with no stall and nothing skipped', async () => {
		const deployment = await deploy({alpha: SOURCE});
		await post(
			deployment,
			'alpha',
			batchOf(deployment, 'alpha', 100, 110, 110, [
				transfer(101, '0xa101', ALICE, 1n),
				transfer(102, '0xa102', BOB, 2n),
				transfer(103, '0xa103', CAROL, 3n),
				transfer(104, '0xa104', ALICE, 4n),
				transfer(105, '0xa105', BOB, 5n),
				transfer(106, '0xa106', CAROL, 6n),
				transfer(107, '0xa107', ALICE, 7n),
				transfer(108, '0xa108', BOB, 8n),
			]),
		);

		// a hole at the START of the stream, a RUN of holes in the middle, and one
		// immediately before the end: every shape a page boundary can land on
		await punch(deployment.db, [1, 3, 4, 5, 7]);

		const remaining = (
			await deployment.db.prepare(`SELECT seq FROM EmissionStream ORDER BY seq`).all<{seq: number}>()
		).results.map((row) => row.seq);
		expect(remaining).toEqual([2, 6, 8]);

		// the page size is SMALLER than the widest hole, which is the case an
		// incrementing consumer stalls on
		const followed = await follow(deployment, 'alpha', 1);
		expect(followed.entries.map((entry) => entry.blockNumber)).toEqual([102, 106, 108]);
		expect(new Set(followed.entries.map(identityOf)).size).toBe(3);
	});

	it('reaches the same entries at every page size over a holed stream', async () => {
		const deployment = await deploy({alpha: SOURCE});
		await post(
			deployment,
			'alpha',
			batchOf(deployment, 'alpha', 100, 110, 110, [
				transfer(101, '0xa101', ALICE, 1n),
				transfer(102, '0xa102', BOB, 2n),
				transfer(103, '0xa103', CAROL, 3n),
				transfer(104, '0xa104', ALICE, 4n),
				transfer(105, '0xa105', BOB, 5n),
			]),
		);
		await punch(deployment.db, [2, 4]);

		const whole = await follow(deployment, 'alpha', 100);
		expect(whole.entries.map((entry) => entry.blockNumber)).toEqual([101, 103, 105]);
		for (const limit of [1, 2, 3]) {
			const paged = await follow(deployment, 'alpha', limit);
			expect(paged.entries.map(identityOf)).toEqual(whole.entries.map(identityOf));
		}
	});
});

describe('the cursor is OPAQUE', () => {
	it("carries no position a client can read without the server's decoder", async () => {
		const deployment = await deploy({alpha: SOURCE});
		await post(
			deployment,
			'alpha',
			batchOf(deployment, 'alpha', 100, 110, 110, [
				transfer(101, '0xa101', ALICE, 1n),
				transfer(102, '0xa102', BOB, 2n),
				transfer(103, '0xa103', CAROL, 3n),
			]),
		);

		const page = await readFeed(deployment, 'alpha', {limit: 3});
		const cursor = page.body.cursor;

		// not the name, not the stream, not a position, in any form a client can
		// reach for: not the string itself, not JSON, not base64
		expect(cursor).not.toContain('alpha');
		expect(cursor).not.toContain(STREAM_DIGEST);
		expect(() => JSON.parse(cursor)).toThrow();

		const decodedAsBase64 = tryBase64(cursor);
		expect(decodedAsBase64).not.toContain('alpha');
		expect(decodedAsBase64).not.toContain(STREAM_DIGEST);
		expect(decodedAsBase64).not.toContain('seq');
		expect(() => JSON.parse(decodedAsBase64)).toThrow();

		// and the SERVER's decoder does read it, which is what "without the decoder"
		// is measured against
		const opened = decodeFeedCursor(cursor);
		expect(opened?.indexer).toBe('alpha');
		expect(opened?.stream).toBe(STREAM_DIGEST);
		expect(opened?.at).toEqual({seq: 3});
	});

	it('documents nothing about its encoding in the response', async () => {
		const deployment = await deploy({alpha: SOURCE});
		await post(deployment, 'alpha', batchOf(deployment, 'alpha', 100, 110, 110, [transfer(101, '0xa101', ALICE, 1n)]));

		const page = await readFeed(deployment, 'alpha', {limit: 1});

		// no `seq` anywhere in the body OUTSIDE the opaque cursor, on an entry or
		// beside it: the position is the cursor's business and a consumer never
		// handles one
		expect(page.text.replace(page.body.cursor, '')).not.toContain('seq');
		// `generation` is the one other identity a page carries: WHICH FOLD answered,
		// advertised because no cursor check can see a fold change over one stream
		expect(Object.keys(page.body).sort()).toEqual(['cursor', 'entries', 'generation', 'hasMore', 'stream', 'success']);
		expect(Object.keys(page.body.entries[0] as object).sort()).toEqual([
			'address',
			'blockHash',
			'blockNumber',
			'blockTimestamp',
			'data',
			'logIndex',
			'removed',
			'topics',
			'transactionHash',
			'transactionIndex',
		]);
	});

	it('refuses a cursor that was edited, rather than reading a position out of the wreckage', async () => {
		const deployment = await deploy({alpha: SOURCE});
		await post(deployment, 'alpha', batchOf(deployment, 'alpha', 100, 110, 110, [transfer(101, '0xa101', ALICE, 1n)]));

		const page = await readFeed(deployment, 'alpha', {limit: 1});
		const edited = `${page.body.cursor.slice(0, -2)}${page.body.cursor.endsWith('A') ? 'BB' : 'AA'}`;

		const refused = await readFeed(deployment, 'alpha', {cursor: edited});
		expect(refused.status).toBe(400);
		expect(refused.body.error).toBe('invalid-cursor');

		const nonsense = await readFeed(deployment, 'alpha', {cursor: 'not-a-cursor-at-all'});
		expect(nonsense.status).toBe(400);
		expect(nonsense.body.error).toBe('invalid-cursor');
	});
});

/** Decode base64url the way a client poking at an opaque string would. */
function tryBase64(text: string): string {
	try {
		const normalised = text.replace(/-/g, '+').replace(/_/g, '/');
		const bytes = Uint8Array.from(atob(normalised.padEnd(Math.ceil(normalised.length / 4) * 4, '=')), (ch) =>
			ch.charCodeAt(0),
		);
		return new TextDecoder('utf-8', {fatal: false}).decode(bytes);
	} catch {
		return '';
	}
}

describe('a cursor minted for one indexer is REFUSED at another, never re-interpreted', () => {
	it("refuses it, and serves the other indexer nothing of the first one's stream", async () => {
		// IDENTICAL sources, so the STREAM digest cannot tell them apart and the NAME
		// is the only thing that does -- which is exactly when a re-interpretation
		// would look plausible
		const deployment = await deploy({alpha: SOURCE, beta: IDENTICAL_SOURCE});
		await post(
			deployment,
			'alpha',
			batchOf(deployment, 'alpha', 100, 110, 110, [
				transfer(101, '0xa101', ALICE, 1n),
				transfer(102, '0xa102', BOB, 2n),
			]),
		);
		await post(deployment, 'beta', batchOf(deployment, 'beta', 100, 110, 110, [transfer(105, '0xb105', CAROL, 9n)]));

		const alphaPage = await readFeed(deployment, 'alpha', {limit: 1});
		expect(alphaPage.status).toBe(200);

		const presented = await readFeed(deployment, 'beta', {cursor: alphaPage.body.cursor});
		expect(presented.status).toBe(400);
		expect(presented.body.error).toBe('indexer-mismatch');
		expect(presented.body.indexer).toBe('beta');
		expect(presented.body.entries).toBeUndefined();
		// and the refusal does not hand back the OTHER tenant's name
		expect(presented.text).not.toContain('alpha');

		// beta's own feed is untouched and holds only beta's rows
		const betaOwn = await follow(deployment, 'beta', 10);
		expect(betaOwn.entries.map((entry) => entry.blockNumber)).toEqual([105]);
	});

	it('refuses a name this host was not built with, and says so before any cursor is read', async () => {
		const deployment = await deploy({alpha: SOURCE});

		const unknown = await readFeed(deployment, 'gamma');
		expect(unknown.status).toBe(404);
		expect(unknown.body.error).toBe('unknown-indexer');
	});

	it('answers 501 on a host built with no registry at all', async () => {
		const db: RemoteSQL = new RemoteLibSQL(createClient({url: ':memory:'}));
		const app = createServer<TestEnv>({getDB: () => db, getEnv: () => ({INGEST_TOKEN: TOKEN})});
		await app.request('/admin/setup', {method: 'POST'});

		const res = await app.request('/alpha/feed');
		expect(res.status).toBe(501);
		expect(((await res.json()) as {error: string}).error).toBe('ingestion-not-configured');
	});
});

describe('a cursor whose STREAM is no longer served is REFUSED, and the refusal says what to do', () => {
	/**
	 * The plausible-wrong-answer this prevents: `seq` 4 in one stream and `seq` 4
	 * in another are unrelated positions, so continuing across them would answer
	 * with logs the consumer never asked for and could not tell apart.
	 */
	async function reconfigured(): Promise<{before: Deployment; after: Deployment; staleCursor: string}> {
		const before = await deploy({alpha: SOURCE});
		await post(
			before,
			'alpha',
			batchOf(before, 'alpha', 100, 110, 110, [
				transfer(101, '0xa101', ALICE, 1n),
				transfer(102, '0xa102', BOB, 2n),
				transfer(103, '0xa103', CAROL, 3n),
			]),
		);
		const page = await readFeed(before, 'alpha', {limit: 2});
		expect(page.status).toBe(200);

		// the same name, redeployed against a DIFFERENT fetch filter, over the SAME
		// database: a new stream rather than a fork of the old one
		const after = await deploy({alpha: RECONFIGURED_SOURCE}, before.db);
		await post(
			after,
			'alpha',
			batchOf(after, 'alpha', 100, 110, 110, [
				transfer(101, '0xc101', ALICE, 11n, 0, OTHER_CONTRACT),
				transfer(104, '0xc104', BOB, 12n, 0, OTHER_CONTRACT),
			]),
		);

		return {before, after, staleCursor: page.body.cursor};
	}

	it('refuses it and answers with the CURRENT stream identity and where its feed starts', async () => {
		const {after, staleCursor} = await reconfigured();

		const refused = await readFeed(after, 'alpha', {cursor: staleCursor});

		expect(refused.status).toBe(400);
		expect(refused.body.error).toBe('stream-mismatch');
		// the two things a consumer needs in order to RE-SUBSCRIBE deliberately
		expect(refused.body.stream).toBe(RECONFIGURED_DIGEST);
		expect(typeof refused.body.startCursor).toBe('string');
		expect(refused.body.entries).toBeUndefined();
	});

	it('is NOT a rewind: there is no fork block, because the old logs were never on this stream', async () => {
		const {after, staleCursor} = await reconfigured();

		const refused = await readFeed(after, 'alpha', {cursor: staleCursor});

		// nothing that would let a consumer read this as "go back to block F and
		// carry on": a filter change produced logs that were never on the old stream
		expect(Object.keys(refused.body).sort()).toEqual([
			'error',
			'generation',
			'message',
			'startCursor',
			'stream',
			'success',
		]);
		const withoutCursor = refused.text.replace(refused.body.startCursor as string, '');
		expect(withoutCursor).not.toContain('rewind');
		expect(withoutCursor).not.toContain('forkBlock');
	});

	it('re-subscribes from the position the refusal named, and gets the whole new stream', async () => {
		const {after, staleCursor} = await reconfigured();
		const refused = await readFeed(after, 'alpha', {cursor: staleCursor});

		const resumed = await readFeed(after, 'alpha', {cursor: refused.body.startCursor as string, limit: 10});
		expect(resumed.status).toBe(200);
		expect(resumed.body.stream).toBe(RECONFIGURED_DIGEST);
		expect(resumed.body.entries.map((entry) => entry.blockNumber)).toEqual([101, 104]);
		// and it is the NEW stream's logs, not the old one's, at those heights
		expect(resumed.body.entries.every((entry) => entry.address === OTHER_CONTRACT)).toBe(true);
	});

	it('refuses a cursor minted for the OTHER view, rather than reading its position as a seq', async () => {
		const deployment = await deploy({alpha: SOURCE});
		await post(deployment, 'alpha', batchOf(deployment, 'alpha', 100, 110, 110, [transfer(101, '0xa101', ALICE, 1n)]));

		const foreignView = encodeFeedCursor({
			view: 'canonical',
			indexer: 'alpha',
			stream: STREAM_DIGEST,
			at: {blockNumber: 101, logIndex: 0},
		});

		const refused = await readFeed(deployment, 'alpha', {cursor: foreignView});
		expect(refused.status).toBe(400);
		expect(refused.body.error).toBe('view-mismatch');
		expect(refused.body.view).toBe(STREAM_FEED_VIEW);
	});
});

describe("the page size is the caller's within a bound, and an unusable one is refused", () => {
	let deployment: Deployment;

	beforeEach(async () => {
		clearLastError();
		deployment = await deploy({alpha: SOURCE});
		await post(
			deployment,
			'alpha',
			batchOf(deployment, 'alpha', 100, 110, 110, [
				transfer(101, '0xa101', ALICE, 1n),
				transfer(102, '0xa102', BOB, 2n),
				transfer(103, '0xa103', CAROL, 3n),
			]),
		);
	});

	it('defaults when none is asked for', async () => {
		const page = await readFeed(deployment, 'alpha');
		expect(page.status).toBe(200);
		expect(page.body.entries).toHaveLength(3);
		expect(page.body.hasMore).toBe(false);
	});

	it("honours a caller's smaller page", async () => {
		const page = await readFeed(deployment, 'alpha', {limit: 1});
		expect(page.body.entries).toHaveLength(1);
		expect(page.body.hasMore).toBe(true);
	});

	it('REFUSES a page size above the bound rather than silently serving fewer', async () => {
		const page = await readFeed(deployment, 'alpha', {limit: 100_000});
		expect(page.status).toBe(400);
		expect(page.body.error).toBe('invalid-limit');
		// the bound is stated, so the caller can act on the refusal
		expect(typeof page.body.maxLimit).toBe('number');
	});

	it('refuses a page size that is not a positive whole number', async () => {
		for (const limit of ['0', '-1', '1.5', 'lots', '']) {
			const page = await readFeed(deployment, 'alpha', {limit});
			expect(page.status, `limit=${JSON.stringify(limit)}`).toBe(400);
			expect(page.body.error).toBe('invalid-limit');
		}
	});
});

describe('the feed is a READ and is not behind the ingest token', () => {
	it("answers an anonymous caller, unlike the fetcher's private ingest routes", async () => {
		const deployment = await deploy({alpha: SOURCE});
		await post(deployment, 'alpha', batchOf(deployment, 'alpha', 100, 110, 110, [transfer(101, '0xa101', ALICE, 1n)]));

		const page = await deployment.app.request('/alpha/feed');
		expect(page.status).toBe(200);

		const ingest = await deployment.app.request('/alpha/ingest', {method: 'POST', body: '{}'});
		expect(ingest.status).toBe(401);
	});
});
