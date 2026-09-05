import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createClient} from '@libsql/client';
import {RemoteLibSQL} from 'remote-sql-libsql';
import type {RemoteSQL} from 'remote-sql';
import {beforeEach, describe, expect, it} from 'vitest';
import {createServer} from '../src/index.js';
import {clearLastError} from '../src/api/status.js';
import {CANONICAL_FEED_VIEW, decodeFeedCursor, encodeFeedCursor, STREAM_FEED_VIEW} from '../src/feed/cursor.js';
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
	readCanonical as read,
	reorgAt103,
	indexedThroughBlock105,
	transfer,
	type Deployment,
	type TestEnv,
} from './utils/feedHarness.js';

// ---------------------------------------------------------------------------
// THE CANONICAL VIEW (ADR-0006, the second of the two views)
// ---------------------------------------------------------------------------
// `GET /{indexer}/canonical?gate=<block>`: live entries only, ordered by
// `(blockNumber, logIndex)`, at or below the CALLER's gate. This is the view for
// a consumer that never wants to hear the word reorg, so its whole sync state is
// one advancing position.
//
// Because it HIDES reorgs it owes the compensating guarantee, and that is what
// most of this file is about: the cursor carries the block HASH the consumer
// last saw, the server VALIDATES it, and a cursor whose block is no longer
// canonical answers REWIND TO FORK BLOCK F. The failure being engineered against
// is precise and silent -- a consumer resuming at `(105, 3)` after block 103 was
// replaced is served the NEW branch from that key onward and never sees the new
// 103 and 104 at all -- so the reorg here is driven through the INGEST path and
// derived by the stream-builder, never synthesised by editing rows.
// ---------------------------------------------------------------------------

const pkgRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');

type CanonicalEntryShape = {
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
 * A canonical response as a TEST reads it: the page's fields, the refusals' and
 * the rewind's in one shape.
 *
 * One type rather than a union because every assertion here already knows which
 * it is looking at (it asserted the status first), and narrowing would prove
 * nothing about the server.
 */
type CanonicalBody = {
	success: boolean;
	stream: string;
	entries: CanonicalEntryShape[];
	cursor: string;
	hasMore: boolean;
	error?: string;
	indexer?: string;
	view?: string;
	maxLimit?: number;
	startCursor?: string;
	forkBlock?: number;
	rewindCursor?: string;
	message?: string;
};

/** The harness's reader, at this suite's idea of what a canonical response holds. */
async function readCanonical(
	deployment: Deployment,
	name: string,
	query: {gate?: number | string; cursor?: string; limit?: number | string} = {},
): Promise<{status: number; body: CanonicalBody; text: string}> {
	return read<CanonicalBody>(deployment, name, query);
}

/**
 * Follow the canonical view to its end the way a SIMPLE consumer does: hold one
 * cursor, present it back, stop when told there is no more. No reorg handling,
 * no arithmetic on a position, no second piece of state.
 */
async function follow(
	deployment: Deployment,
	name: string,
	gate: number,
	limit: number,
): Promise<{entries: CanonicalEntryShape[]; cursor: string}> {
	const entries: CanonicalEntryShape[] = [];
	let cursor: string | undefined;
	// bounded so a STALL fails as a test rather than as a hang
	for (let guard = 0; guard < 50; guard++) {
		const page = await readCanonical(deployment, name, {gate, cursor, limit});
		expect(page.status, page.text).toBe(200);
		entries.push(...page.body.entries);
		cursor = page.body.cursor;
		if (!page.body.hasMore) return {entries, cursor};
	}
	throw new Error(`the canonical view never reported itself caught up: it stalled or repeated`);
}

/** What identifies ONE entry for "nothing skipped and nothing repeated". */
function identityOf(entry: CanonicalEntryShape): string {
	return `${entry.blockHash}:${entry.logIndex}`;
}

// ---------------------------------------------------------------------------

describe('the view serves only LIVE entries, in block and log-index order', () => {
	it('never serves a retraction, nor the entries a reorg took back', async () => {
		const deployment = await indexedThroughBlock105();
		await reorgAt103(deployment);

		// the table HOLDS all of it: three retractions and three dead originals,
		// which is what the other view exists to deliver
		const stored = (
			await deployment.db
				.prepare(`SELECT COUNT(*) AS n FROM _emissions WHERE removed = 1 OR alive = 0`)
				.all<{n: number}>()
		).results[0]?.n;
		expect(stored).toBe(6);

		const followed = await follow(deployment, 'alpha', 200, 100);

		expect(followed.entries.map((entry) => [entry.blockNumber, entry.blockHash])).toEqual([
			[101, '0xa101'],
			[103, '0xb103'],
			[104, '0xb104'],
			[106, '0xb106'],
		]);
		// no entry carries a verdict at all: a `removed` that is false on every
		// entry is an invitation to write reorg handling that can never fire
		for (const entry of followed.entries) {
			expect(Object.keys(entry)).not.toContain('removed');
			expect(Object.keys(entry)).not.toContain('alive');
			expect(Object.keys(entry)).not.toContain('seq');
		}
	});

	it('carries the raw log the node reported, and no position', async () => {
		const deployment = await deploy({alpha: SOURCE});
		await post(deployment, 'alpha', batchOf(deployment, 'alpha', 100, 110, 110, [transfer(101, '0xa101', ALICE, 1n)]));

		const page = await readCanonical(deployment, 'alpha', {gate: 110});
		expect(page.status).toBe(200);
		expect(page.body.entries[0]).toEqual({
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
		expect(Object.keys(page.body).sort()).toEqual(['cursor', 'entries', 'generation', 'hasMore', 'stream', 'success']);
		// no `seq` outside the opaque cursor: this view does not count in that space
		expect(page.text.replace(page.body.cursor, '')).not.toContain('seq');
	});

	it('orders by (blockNumber, logIndex) and NOT by the order rows were stored in', async () => {
		const deployment = await deploy({alpha: SOURCE});
		await post(
			deployment,
			'alpha',
			batchOf(deployment, 'alpha', 100, 110, 110, [
				transfer(101, '0xa101', ALICE, 1n, 0),
				transfer(103, '0xa103', BOB, 2n, 0),
				transfer(103, '0xa103', CAROL, 3n, 1),
				transfer(103, '0xa103', ALICE, 4n, 2),
				transfer(104, '0xa104', BOB, 5n, 0),
			]),
		);

		// INVERT the storage order. `seq` is the OTHER view's axis and this one must
		// not be reading it: after this the two orders disagree everywhere, so a read
		// that fell back to insertion order answers backwards.
		await deployment.db.prepare(`UPDATE _emissions SET seq = 1000 - seq`).all();

		const followed = await follow(deployment, 'alpha', 110, 2);
		expect(followed.entries.map((entry) => [entry.blockNumber, entry.logIndex])).toEqual([
			[101, 0],
			[103, 0],
			[103, 1],
			[103, 2],
			[104, 0],
		]);
	});
});

describe("the block gate is the CALLER's", () => {
	let deployment: Deployment;

	beforeEach(async () => {
		clearLastError();
		deployment = await deploy({alpha: SOURCE});
		await post(
			deployment,
			'alpha',
			batchOf(deployment, 'alpha', 100, 110, 110, [
				transfer(101, '0xa101', ALICE, 1n),
				transfer(105, '0xa105', BOB, 2n),
				transfer(109, '0xa109', CAROL, 3n),
			]),
		);
	});

	it('does not serve an entry above the gate, and serves it when the gate is raised', async () => {
		const low = await readCanonical(deployment, 'alpha', {gate: 105});
		expect(low.status).toBe(200);
		expect(low.body.entries.map((entry) => entry.blockNumber)).toEqual([101, 105]);
		expect(low.body.hasMore).toBe(false);

		// the SAME cursor, a HIGHER gate: what was withheld is now served, and
		// nothing already delivered is repeated
		const raised = await readCanonical(deployment, 'alpha', {gate: 110, cursor: low.body.cursor});
		expect(raised.status).toBe(200);
		expect(raised.body.entries.map((entry) => entry.blockNumber)).toEqual([109]);
	});

	it('is REQUIRED: the server does not pick a consumer\u2019s risk appetite', async () => {
		const missing = await readCanonical(deployment, 'alpha');
		expect(missing.status).toBe(400);
		expect(missing.body.error).toBe('invalid-gate');
		// and it says WHY, because the caller has to choose one
		expect(missing.body.message).toContain('gate');

		// nothing was served, in particular not "everything up to the tip"
		expect(missing.body.entries).toBeUndefined();
	});

	it('refuses a gate that is not a whole block number', async () => {
		for (const gate of ['-1', '1.5', 'latest', 'finalized', '']) {
			const refused = await readCanonical(deployment, 'alpha', {gate});
			expect(refused.status, `gate=${JSON.stringify(gate)}`).toBe(400);
			expect(refused.body.error).toBe('invalid-gate');
		}
	});

	it('serves an empty page below every entry rather than refusing', async () => {
		const page = await readCanonical(deployment, 'alpha', {gate: 100});
		expect(page.status).toBe(200);
		expect(page.body.entries).toEqual([]);
		expect(page.body.hasMore).toBe(false);
		expect(typeof page.body.cursor).toBe('string');
	});
});

describe('a consumer follows it with ONE advancing position and no reorg handling', () => {
	it('lands on the same set at every page size as a from-scratch read of the same gate', async () => {
		const deployment = await deploy({alpha: SOURCE});
		await post(
			deployment,
			'alpha',
			batchOf(deployment, 'alpha', 100, 110, 110, [
				transfer(101, '0xa101', ALICE, 1n),
				transfer(102, '0xa102', BOB, 2n),
				transfer(103, '0xa103', CAROL, 3n, 0),
				transfer(103, '0xa103', ALICE, 4n, 1),
				transfer(107, '0xa107', BOB, 5n),
			]),
		);

		const whole = await follow(deployment, 'alpha', 110, 1000);
		expect(whole.entries).toHaveLength(5);

		for (const limit of [1, 2, 3, 5]) {
			const paged = await follow(deployment, 'alpha', 110, limit);
			expect(paged.entries.map(identityOf)).toEqual(whole.entries.map(identityOf));
			expect(new Set(paged.entries.map(identityOf)).size).toBe(paged.entries.length);
		}
	});

	it('keeps answering a caught-up cursor with an empty page, and keeps handing one back', async () => {
		const deployment = await deploy({alpha: SOURCE});
		await post(deployment, 'alpha', batchOf(deployment, 'alpha', 100, 110, 110, [transfer(101, '0xa101', ALICE, 1n)]));

		const caughtUp = await follow(deployment, 'alpha', 110, 1);

		const again = await readCanonical(deployment, 'alpha', {gate: 110, cursor: caughtUp.cursor});
		expect(again.status).toBe(200);
		expect(again.body.entries).toEqual([]);
		expect(again.body.hasMore).toBe(false);

		// the empty page did not drop the block hash: the next request still has
		// something to validate
		const resumed = await readCanonical(deployment, 'alpha', {gate: 110, cursor: again.body.cursor});
		expect(resumed.status).toBe(200);
		expect(decodeFeedCursor(again.body.cursor)?.at['blockHash']).toBe('0xa101');
	});
});

describe('a cursor whose block is no longer canonical answers REWIND TO FORK BLOCK F', () => {
	it('names the fork block, which is BELOW the cursor rather than at it', async () => {
		const deployment = await indexedThroughBlock105();
		const caughtUp = await follow(deployment, 'alpha', 200, 100);
		expect(caughtUp.entries.map((entry) => entry.blockNumber)).toEqual([101, 103, 104, 105]);

		await reorgAt103(deployment);

		const answer = await readCanonical(deployment, 'alpha', {gate: 200, cursor: caughtUp.cursor});

		expect(answer.status).toBe(409);
		expect(answer.body.error).toBe('rewind-required');
		// F is 103, the lowest block the chain changed at -- NOT 105, the block the
		// cursor names. Answering 105 is precisely the silent skip: the consumer
		// would never receive the new 103 and 104.
		expect(answer.body.forkBlock).toBe(103);
		expect(typeof answer.body.rewindCursor).toBe('string');
		expect(answer.body.stream).toBe(STREAM_DIGEST);
		// no page came back with it: a rewind is never something a consumer can miss
		// by ignoring a field it does not know
		expect(answer.body.entries).toBeUndefined();
		expect(Object.keys(answer.body).sort()).toEqual([
			'error',
			'forkBlock',
			'generation',
			'message',
			'rewindCursor',
			'stream',
			'success',
		]);
	});

	it('delivers everything after the rewind, including what the consumer never received', async () => {
		const deployment = await indexedThroughBlock105();
		const caughtUp = await follow(deployment, 'alpha', 200, 100);
		await reorgAt103(deployment);

		const answer = await readCanonical(deployment, 'alpha', {gate: 200, cursor: caughtUp.cursor});
		expect(answer.status).toBe(409);

		// the consumer does the ONE thing this view asks of it: roll its own state
		// back to before `forkBlock`, present `rewindCursor`, carry on
		const resumed = await readCanonical(deployment, 'alpha', {
			gate: 200,
			cursor: answer.body.rewindCursor as string,
		});
		expect(resumed.status).toBe(200);
		expect(resumed.body.entries.map((entry) => [entry.blockNumber, entry.blockHash])).toEqual([
			// the replacement branch, from the fork INCLUSIVE
			[103, '0xb103'],
			[104, '0xb104'],
			// and the block that only exists on the new branch, which a naive resume
			// from (105, 0) would have been the ONLY thing to deliver
			[106, '0xb106'],
		]);
		expect(resumed.body.hasMore).toBe(false);

		// nothing below the fork is re-delivered: the prefix behind it was never
		// invalidated, which is the whole point of validating one block
		expect(resumed.body.entries.some((entry) => entry.blockNumber === 101)).toBe(false);

		// and after rewinding once, following on lands where a from-scratch read of
		// the same gate lands
		const fromScratch = await follow(deployment, 'alpha', 200, 2);
		expect(fromScratch.entries.map(identityOf)).toEqual(['0xa101:0', '0xb103:0', '0xb104:0', '0xb106:0']);
	});

	it('does NOT rewind a consumer whose own block survived the reorg', async () => {
		const deployment = await indexedThroughBlock105();
		// gated at 102, this consumer only ever saw block 101, which the reorg at
		// 103 did not touch. ADR-0007's safe lane: below the gate nothing moves.
		const safe = await readCanonical(deployment, 'alpha', {gate: 102});
		expect(safe.body.entries.map((entry) => entry.blockNumber)).toEqual([101]);

		await reorgAt103(deployment);

		const next = await readCanonical(deployment, 'alpha', {gate: 102, cursor: safe.body.cursor});
		expect(next.status).toBe(200);
		expect(next.body.entries).toEqual([]);

		// and raising the gate afterwards serves the NEW branch, never the old one
		const raised = await readCanonical(deployment, 'alpha', {gate: 200, cursor: next.body.cursor});
		expect(raised.status).toBe(200);
		expect(raised.body.entries.map((entry) => entry.blockHash)).toEqual(['0xb103', '0xb104', '0xb106']);
	});

	it('moves the fork DOWN when a later reorg reaches further back than the first', async () => {
		const deployment = await indexedThroughBlock105();
		const caughtUp = await follow(deployment, 'alpha', 200, 100);

		// FIRST reorg: 103 still carries the same hash, so the fork is 104
		await post(
			deployment,
			'alpha',
			batchOf(deployment, 'alpha', 102, 106, 106, [
				transfer(103, '0xa103', BOB, 2n),
				transfer(104, '0xb104', ALICE, 14n),
				transfer(106, '0xb106', BOB, 16n),
			]),
		);
		const shallow = await readCanonical(deployment, 'alpha', {gate: 200, cursor: caughtUp.cursor});
		expect(shallow.status).toBe(409);
		expect(shallow.body.forkBlock).toBe(104);

		// SECOND reorg, deeper: now 103 is replaced too. The consumer still holds the
		// cursor it minted before either, and the answer must move DOWN -- taking the
		// lowest block retracted since the cursor was minted is what makes that so,
		// and answering the first fork would leave the new 103 undelivered for ever.
		await post(
			deployment,
			'alpha',
			batchOf(deployment, 'alpha', 103, 107, 107, [
				transfer(103, '0xc103', CAROL, 23n),
				transfer(105, '0xc105', ALICE, 25n),
			]),
		);

		const deeper = await readCanonical(deployment, 'alpha', {gate: 200, cursor: caughtUp.cursor});
		expect(deeper.status).toBe(409);
		expect(deeper.body.forkBlock).toBe(103);

		const resumed = await readCanonical(deployment, 'alpha', {
			gate: 200,
			cursor: deeper.body.rewindCursor as string,
		});
		expect(resumed.body.entries.map((entry) => entry.blockHash)).toEqual(['0xc103', '0xc105']);
	});
});

describe('there is exactly ONE cursor codec, shared with the seq stream', () => {
	function sourceFiles(dir: string): string[] {
		return readdirSync(dir).flatMap((entry) => {
			const full = join(dir, entry);
			if (statSync(full).isDirectory()) return sourceFiles(full);
			return full.endsWith('.ts') ? [full] : [];
		});
	}

	const files = sourceFiles(join(pkgRoot, 'src'));

	it('has source files to check (guards against this test silently passing on an empty scan)', () => {
		expect(files.length).toBeGreaterThan(4);
	});

	it('declares the encoder and the decoder in one file and nowhere else', () => {
		// two encoders would be two refusal paths, and they would drift: the whole
		// reason the canonical view puts its block hash INSIDE the shared envelope
		// rather than minting an encoding of its own
		const declaring = (pattern: RegExp) =>
			files.filter((file) => pattern.test(readFileSync(file, 'utf-8'))).map((file) => file.slice(pkgRoot.length + 1));

		expect(declaring(/function encode\w*Cursor\b/)).toEqual(['src/feed/cursor.ts']);
		expect(declaring(/function decode\w*Cursor\b/)).toEqual(['src/feed/cursor.ts']);
		// and no second base64 alphabet, which is what a hand-rolled rival encoder
		// would need
		expect(declaring(/ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789/)).toEqual(['src/feed/cursor.ts']);
	});

	it("opens the canonical view's cursor with the seq feed's decoder", async () => {
		const deployment = await deploy({alpha: SOURCE});
		await post(deployment, 'alpha', batchOf(deployment, 'alpha', 100, 110, 110, [transfer(101, '0xa101', ALICE, 1n)]));

		const page = await readCanonical(deployment, 'alpha', {gate: 110});
		const opened = decodeFeedCursor(page.body.cursor);

		expect(opened?.view).toBe(CANONICAL_FEED_VIEW);
		expect(opened?.indexer).toBe('alpha');
		expect(opened?.stream).toBe(STREAM_DIGEST);
		expect(opened?.at['blockNumber']).toBe(101);
		expect(opened?.at['logIndex']).toBe(0);
		expect(opened?.at['blockHash']).toBe('0xa101');
	});

	it('keeps the two views apart: neither serves the other\u2019s cursor', async () => {
		const deployment = await deploy({alpha: SOURCE});
		await post(deployment, 'alpha', batchOf(deployment, 'alpha', 100, 110, 110, [transfer(101, '0xa101', ALICE, 1n)]));

		const canonical = await readCanonical(deployment, 'alpha', {gate: 110});
		const seq = await deployment.app.request('/alpha/feed');
		const seqCursor = ((await seq.json()) as {cursor: string}).cursor;

		const atSeqFeed = await deployment.app.request(`/alpha/feed?cursor=${encodeURIComponent(canonical.body.cursor)}`);
		expect(atSeqFeed.status).toBe(400);
		expect(((await atSeqFeed.json()) as {error: string; view: string}).view).toBe(STREAM_FEED_VIEW);

		const atCanonical = await readCanonical(deployment, 'alpha', {gate: 110, cursor: seqCursor});
		expect(atCanonical.status).toBe(400);
		expect(atCanonical.body.error).toBe('view-mismatch');
		expect(atCanonical.body.view).toBe(CANONICAL_FEED_VIEW);
	});

	it('is OPAQUE here too: nothing a client can read out without the decoder', async () => {
		const deployment = await deploy({alpha: SOURCE});
		await post(deployment, 'alpha', batchOf(deployment, 'alpha', 100, 110, 110, [transfer(101, '0xa101', ALICE, 1n)]));

		const page = await readCanonical(deployment, 'alpha', {gate: 110});
		const cursor = page.body.cursor;

		expect(cursor).not.toContain('alpha');
		expect(cursor).not.toContain(STREAM_DIGEST);
		expect(cursor).not.toContain('0xa101');
		expect(() => JSON.parse(cursor)).toThrow();
	});

	it('refuses an edited cursor rather than reading a position out of the wreckage', async () => {
		const deployment = await deploy({alpha: SOURCE});
		await post(deployment, 'alpha', batchOf(deployment, 'alpha', 100, 110, 110, [transfer(101, '0xa101', ALICE, 1n)]));

		const page = await readCanonical(deployment, 'alpha', {gate: 110});
		const edited = `${page.body.cursor.slice(0, -2)}${page.body.cursor.endsWith('A') ? 'BB' : 'AA'}`;

		const refused = await readCanonical(deployment, 'alpha', {gate: 110, cursor: edited});
		expect(refused.status).toBe(400);
		expect(refused.body.error).toBe('invalid-cursor');
	});

	it('refuses a cursor whose position is not one this view could have written', async () => {
		const deployment = await deploy({alpha: SOURCE});
		await post(deployment, 'alpha', batchOf(deployment, 'alpha', 100, 110, 110, [transfer(101, '0xa101', ALICE, 1n)]));

		// the right view, the right indexer, the right stream, and a position with no
		// mark on it: not a cursor this server minted
		const handCrafted = encodeFeedCursor({
			view: CANONICAL_FEED_VIEW,
			indexer: 'alpha',
			stream: STREAM_DIGEST,
			at: {blockNumber: 101, logIndex: 0},
		});

		const refused = await readCanonical(deployment, 'alpha', {gate: 110, cursor: handCrafted});
		expect(refused.status).toBe(400);
		expect(refused.body.error).toBe('invalid-cursor');
	});
});

describe('the name and stream refusals behave here exactly as they do on the seq feed', () => {
	it('refuses a cursor minted at another named indexer, and names only the one addressed', async () => {
		// IDENTICAL sources, so the STREAM digest cannot tell them apart and the NAME
		// is the only thing that does
		const deployment = await deploy({alpha: SOURCE, beta: IDENTICAL_SOURCE});
		await post(deployment, 'alpha', batchOf(deployment, 'alpha', 100, 110, 110, [transfer(101, '0xa101', ALICE, 1n)]));
		await post(deployment, 'beta', batchOf(deployment, 'beta', 100, 110, 110, [transfer(105, '0xb105', CAROL, 9n)]));

		const alphaPage = await readCanonical(deployment, 'alpha', {gate: 110});
		const presented = await readCanonical(deployment, 'beta', {gate: 110, cursor: alphaPage.body.cursor});

		expect(presented.status).toBe(400);
		expect(presented.body.error).toBe('indexer-mismatch');
		expect(presented.body.indexer).toBe('beta');
		expect(presented.text).not.toContain('alpha');
		expect(presented.body.entries).toBeUndefined();
	});

	it('refuses a cursor for a stream no longer served, and answers where the new one starts', async () => {
		const before = await deploy({alpha: SOURCE});
		await post(before, 'alpha', batchOf(before, 'alpha', 100, 110, 110, [transfer(101, '0xa101', ALICE, 1n)]));
		const stale = (await readCanonical(before, 'alpha', {gate: 110})).body.cursor;

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

		const refused = await readCanonical(after, 'alpha', {gate: 110, cursor: stale});
		expect(refused.status).toBe(400);
		expect(refused.body.error).toBe('stream-mismatch');
		expect(refused.body.stream).toBe(RECONFIGURED_DIGEST);
		expect(typeof refused.body.startCursor).toBe('string');

		// it is NOT a rewind: a filter change produces logs that were never on the
		// old stream, so there is no fork block to name
		const withoutCursor = refused.text.replace(refused.body.startCursor as string, '');
		expect(withoutCursor).not.toContain('forkBlock');
		expect(withoutCursor).not.toContain('rewindCursor');

		// and the answer is followable: the new stream from its start
		const resumed = await readCanonical(after, 'alpha', {gate: 110, cursor: refused.body.startCursor as string});
		expect(resumed.status).toBe(200);
		expect(resumed.body.entries.map((entry) => entry.blockNumber)).toEqual([101, 104]);
		expect(resumed.body.entries.every((entry) => entry.address === OTHER_CONTRACT)).toBe(true);
	});

	it('refuses a name this host was not built with, and answers 501 with no registry at all', async () => {
		const deployment = await deploy({alpha: SOURCE});
		const unknown = await readCanonical(deployment, 'gamma', {gate: 110});
		expect(unknown.status).toBe(404);
		expect(unknown.body.error).toBe('unknown-indexer');

		const db: RemoteSQL = new RemoteLibSQL(createClient({url: ':memory:'}));
		const app = createServer<TestEnv>({getDB: () => db, getEnv: () => ({INGEST_TOKEN: TOKEN})});
		await app.request('/admin/setup', {method: 'POST'});
		const res = await app.request('/alpha/canonical?gate=110');
		expect(res.status).toBe(501);
		expect(((await res.json()) as {error: string}).error).toBe('ingestion-not-configured');
	});

	it('shares the page-size bound and its refusal with the seq feed', async () => {
		const deployment = await deploy({alpha: SOURCE});
		await post(deployment, 'alpha', batchOf(deployment, 'alpha', 100, 110, 110, [transfer(101, '0xa101', ALICE, 1n)]));

		const tooBig = await readCanonical(deployment, 'alpha', {gate: 110, limit: 100_000});
		expect(tooBig.status).toBe(400);
		expect(tooBig.body.error).toBe('invalid-limit');
		expect(tooBig.body.maxLimit).toBe(1000);

		for (const limit of ['0', '-1', '1.5', 'lots']) {
			const refused = await readCanonical(deployment, 'alpha', {gate: 110, limit});
			expect(refused.status, `limit=${JSON.stringify(limit)}`).toBe(400);
			expect(refused.body.error).toBe('invalid-limit');
		}
	});

	it('is a PUBLIC read, like the seq feed and unlike ingest', async () => {
		const deployment = await deploy({alpha: SOURCE});
		await post(deployment, 'alpha', batchOf(deployment, 'alpha', 100, 110, 110, [transfer(101, '0xa101', ALICE, 1n)]));

		const page = await deployment.app.request('/alpha/canonical?gate=110');
		expect(page.status).toBe(200);
	});
});
