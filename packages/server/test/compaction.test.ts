import {describe, expect, it} from 'vitest';
import type {RemoteSQL} from 'remote-sql';
import {compactEmissionPairs, resolvePairCompaction, type PairCompactionReport} from '../src/index.js';
import {
	ALICE,
	BOB,
	CAROL,
	FINALITY,
	SOURCE,
	STREAM_DIGEST,
	batchOf,
	deploy,
	followFeed,
	post,
	readCanonical,
	transfer,
	type Deployment,
} from './utils/feedHarness.js';

// ---------------------------------------------------------------------------
// PAIR-COMPACTION (ADR-0006, off by default; ADR-0019's unit; ADR-0022's shape)
// ---------------------------------------------------------------------------
// Reclaiming the noise a reorg leaves behind: a retracted entry dropped TOGETHER
// WITH its retraction, far below finality, and never by accident.
//
// The three things under test are the three decisions this rides on, and none of
// them is new here:
//
//  - **the DEPTH is block numbers and nothing else, with the finality depth as
//    its FLOOR** (ADR-0019). A duration prunes on the wrong clock, and a depth
//    that would reach into the window where a retraction can still arrive is
//    REFUSED naming the floor rather than clamped to it.
//  - **it is a call the HOST SCHEDULES** (ADR-0022). Appending never compacts, so
//    off-by-default falls out of nobody calling it, and one call does BOUNDED
//    work rather than deleting by an open predicate.
//  - **it is ANSWER-PRESERVING for the canonical view by construction**
//    (ADR-0006), because it only ever removes rows that are already not alive,
//    which that view already excludes. That is the property the whole design
//    rests on, so it is PROVED here (byte-identical responses over one gate)
//    rather than asserted in a comment.
//
// The fixture is driven through `/{indexer}/ingest`, so the stream-builder
// derives its own reorgs and the route writes the rows: an assertion about which
// rows may be dropped is only worth something if the rows arrived the way they
// really do.
// ---------------------------------------------------------------------------

type Row = {
	seq: number;
	removed: number;
	alive: number;
	blockNumber: number;
	blockHash: string;
	logIndex: number;
};

/** Every row of the stream, in `seq` order, as the compaction leaves it. */
async function rowsOf(db: RemoteSQL): Promise<Row[]> {
	return (
		await db
			.prepare(`SELECT seq, removed, alive, blockNumber, blockHash, logIndex FROM _emissions ORDER BY seq`)
			.all<Row>()
	).results.map((row) => ({...row, seq: Number(row.seq)}));
}

/** One row as a test reads it: `<seq> <block> <hash> applied|retracted|dead`. */
function shapeOf(row: Row): string {
	const verdict = row.removed === 1 ? 'retraction' : row.alive === 1 ? 'applied' : 'dead';
	return `${row.seq} ${row.blockNumber} ${row.blockHash} ${verdict}`;
}

/**
 * A stream carrying TWO reorgs at very different depths, and a tip far above the
 * older of them.
 *
 * Blocks 106 and 108 are replaced early and then left far behind (the tip
 * reaches 205), so their pairs are the ones a depth of 50 puts out of reach of
 * any further retraction. Block 199 is replaced at the tip, so its pair is
 * INSIDE the window and must survive every compaction this fixture asks for.
 * Blocks 101, 103 and 150 are never touched and are the control.
 *
 * Batch three re-delivers block 108's log deliberately: the batch covers it, and
 * a batch that held every log in its range except that one would be an ABSENCE
 * and would conclude a third reorg nobody asked for.
 */
async function twoReorgsOneFarBelowTheTip(): Promise<Deployment> {
	const deployment = await deploy({alpha: SOURCE});
	await post(
		deployment,
		'alpha',
		batchOf(deployment, 'alpha', 100, 108, 108, [
			transfer(101, '0xa101', ALICE, 1n),
			transfer(103, '0xa103', BOB, 2n),
			transfer(106, '0xa106', CAROL, 3n),
			transfer(108, '0xa108', ALICE, 4n),
		]),
	);
	// 106 comes back with another hash: 106 and 108 are retracted, and the
	// replacements are applied
	await post(
		deployment,
		'alpha',
		batchOf(deployment, 'alpha', 105, 110, 110, [transfer(106, '0xb106', BOB, 5n), transfer(108, '0xb108', CAROL, 6n)]),
	);
	// the chain runs on to 200, leaving the first reorg far below the tip
	await post(
		deployment,
		'alpha',
		batchOf(deployment, 'alpha', 107, 200, 200, [
			transfer(108, '0xb108', CAROL, 6n),
			transfer(150, '0xa150', ALICE, 7n),
			transfer(199, '0xa199', BOB, 8n),
		]),
	);
	// and a SECOND reorg, this one at the tip
	await post(deployment, 'alpha', batchOf(deployment, 'alpha', 197, 205, 205, [transfer(199, '0xb199', CAROL, 9n)]));
	return deployment;
}

/** What that fixture stores, before anything compacts: nothing is ever deleted on the write path. */
const UNCOMPACTED = [
	'1 101 0xa101 applied',
	'2 103 0xa103 applied',
	'3 106 0xa106 dead',
	'4 108 0xa108 dead',
	'5 106 0xa106 retraction',
	'6 108 0xa108 retraction',
	'7 106 0xb106 applied',
	'8 108 0xb108 applied',
	'9 150 0xa150 applied',
	'10 199 0xa199 dead',
	'11 199 0xa199 retraction',
	'12 199 0xb199 applied',
];

/** A depth well above the finality depth, whose floor (205 - 50) sits between the two reorgs. */
const DEPTH = {blocks: 50} as const;
const TIP = 205;

function compact(
	deployment: Deployment,
	options: {compaction?: {blocks: number} | 'off'; maxPairs?: number; latestBlock?: number} = {},
): Promise<PairCompactionReport> {
	return compactEmissionPairs(deployment.db, {
		indexer: 'alpha',
		stream: STREAM_DIGEST,
		...(options.compaction === undefined ? {} : {compaction: options.compaction}),
		finality: FINALITY,
		latestBlock: options.latestBlock ?? TIP,
		...(options.maxPairs === undefined ? {} : {maxPairs: options.maxPairs}),
	});
}

// ---------------------------------------------------------------------------

describe('the depth is BLOCK NUMBERS, and the finality depth is its FLOOR', () => {
	it('reads a window in blocks, and nothing else', () => {
		expect(resolvePairCompaction({blocks: 50}, {finality: 3})).toEqual({kind: 'window', blocks: 50});
	});

	it('is OFF when a deployment configures nothing, and when it says so', () => {
		expect(resolvePairCompaction(undefined, {finality: 3})).toEqual({kind: 'off'});
		expect(resolvePairCompaction('off', {finality: 3})).toEqual({kind: 'off'});
	});

	it('refuses every unit that is not block numbers, naming the one that is', () => {
		for (const setting of [{seconds: 3600}, {days: 7}, {updates: 100}, 50, '24h', null]) {
			expect(() => resolvePairCompaction(setting as never, {finality: 3})).toThrow(/BLOCK NUMBERS/);
		}
	});

	it('refuses a duration for the reason a duration is wrong: it prunes on the wrong clock', () => {
		expect(() => resolvePairCompaction({seconds: 3600} as never, {finality: 3})).toThrow(/wall-clock/);
	});

	it('REFUSES a depth that would compact at or above latestBlock - finality, naming the floor', () => {
		// a depth of 2 against a finality of 64 would compact 62 blocks INSIDE the
		// window where a retraction can still arrive
		expect(() => resolvePairCompaction({blocks: 2}, {finality: 64})).toThrow(/\b2\b[\s\S]*\b64\b/);
		expect(() => resolvePairCompaction({blocks: 2}, {finality: 64})).toThrow(/finality/i);
		// refused, and NOT clamped to the floor
		expect(() => resolvePairCompaction({blocks: 2}, {finality: 64})).toThrow(/refused|not a suggestion|set the/i);
	});

	it('accepts a depth exactly AT the floor, which compacts strictly below the window', () => {
		expect(resolvePairCompaction({blocks: 64}, {finality: 64})).toEqual({kind: 'window', blocks: 64});
	});

	it('refuses a window that states no finality depth to stand on', () => {
		expect(() => resolvePairCompaction({blocks: 50}, {} as never)).toThrow(/finality/i);
	});

	it('refuses a depth that is not a whole number of blocks', () => {
		for (const blocks of [-1, 1.5, Number.NaN, '50' as never]) {
			expect(() => resolvePairCompaction({blocks} as never, {finality: 3})).toThrow(/blocks/i);
		}
	});
});

describe('nothing compacts unless a HOST asks', () => {
	it('leaves every row in place across four batches and two reorgs: appending never compacts', async () => {
		const deployment = await twoReorgsOneFarBelowTheTip();

		expect((await rowsOf(deployment.db)).map(shapeOf)).toEqual(UNCOMPACTED);
	});

	it('compacts NOTHING for a deployment that configured nothing', async () => {
		const deployment = await twoReorgsOneFarBelowTheTip();

		const report = await compact(deployment);

		expect(report).toEqual({floor: undefined, pairsCompacted: 0, rowsDeleted: 0, scanned: 0, complete: true});
		expect((await rowsOf(deployment.db)).map(shapeOf)).toEqual(UNCOMPACTED);
	});

	it("compacts nothing when a deployment says 'off'", async () => {
		const deployment = await twoReorgsOneFarBelowTheTip();

		expect((await compact(deployment, {compaction: 'off'})).rowsDeleted).toBe(0);
		expect((await rowsOf(deployment.db)).map(shapeOf)).toEqual(UNCOMPACTED);
	});
});

describe('a retracted entry and its retraction go TOGETHER, and only below the depth', () => {
	it('drops both rows of the deep pairs and neither row of the shallow one', async () => {
		const deployment = await twoReorgsOneFarBelowTheTip();

		const report = await compact(deployment, {compaction: DEPTH});

		// the floor is the tip less the depth, and nothing AT it or above is touched
		expect(report.floor).toBe(TIP - DEPTH.blocks);
		expect(report.pairsCompacted).toBe(2);
		expect(report.rowsDeleted).toBe(4);
		expect((await rowsOf(deployment.db)).map(shapeOf)).toEqual([
			'1 101 0xa101 applied',
			'2 103 0xa103 applied',
			// 3, 4, 5 and 6 are gone: two retracted entries with their two retractions
			'7 106 0xb106 applied',
			'8 108 0xb108 applied',
			'9 150 0xa150 applied',
			// the pair at 199 is INSIDE the window, where a retraction can still arrive
			'10 199 0xa199 dead',
			'11 199 0xa199 retraction',
			'12 199 0xb199 applied',
		]);
	});

	it('never renumbers seq: the surviving rows keep the numbers they had', async () => {
		const deployment = await twoReorgsOneFarBelowTheTip();
		const before = (await rowsOf(deployment.db)).filter((row) => ![3, 4, 5, 6].includes(row.seq));

		await compact(deployment, {compaction: DEPTH});

		expect(await rowsOf(deployment.db)).toEqual(before);
	});

	it('never drops a LIVE row, however far below the depth it is', async () => {
		const deployment = await twoReorgsOneFarBelowTheTip();

		// a floor above everything: every row in the table is "far below the depth"
		await compact(deployment, {compaction: {blocks: FINALITY}, latestBlock: 10_000});

		const survivors = await rowsOf(deployment.db);
		expect(survivors.filter((row) => row.alive === 1).map(shapeOf)).toEqual([
			'1 101 0xa101 applied',
			'2 103 0xa103 applied',
			'7 106 0xb106 applied',
			'8 108 0xb108 applied',
			'9 150 0xa150 applied',
			'12 199 0xb199 applied',
		]);
		// and with the floor above the tip, every dead pair went, the one at 199 included
		expect(survivors.filter((row) => row.alive === 0)).toEqual([]);
	});

	it('never drops HALF a pair: a retraction with no entry of its own is left alone', async () => {
		const deployment = await twoReorgsOneFarBelowTheTip();
		// a retraction whose entry is not in the table. It cannot arrive through the
		// route -- the fold only retracts what it applied -- so it is written directly:
		// what is under test is that the rule is PAIRING and not "delete the dead rows".
		await deployment.db
			.prepare(
				`INSERT INTO _emissions (
					indexer, stream, seq, removed, alive, blockNumber, blockHash, logIndex,
					transactionHash, transactionIndex, address, topic0, data
				 ) VALUES ('alpha', ?1, 13, 1, 0, 120, '0xa120', 0, '0xdead', 0, '0xcafe', '0xtopic', '0x')`,
			)
			.bind(STREAM_DIGEST)
			.all();

		const report = await compact(deployment, {compaction: DEPTH});

		expect(report.pairsCompacted).toBe(2);
		expect((await rowsOf(deployment.db)).map((row) => row.seq)).toContain(13);
	});
});

describe('one call performs BOUNDED work', () => {
	it('stops at the budget it was given, and says it is not finished', async () => {
		const deployment = await twoReorgsOneFarBelowTheTip();

		const first = await compact(deployment, {compaction: DEPTH, maxPairs: 1});

		expect(first.pairsCompacted).toBe(1);
		expect(first.rowsDeleted).toBe(2);
		expect(first.complete).toBe(false);
		// the whole pair went, and nothing beyond it
		expect((await rowsOf(deployment.db)).map((row) => row.seq)).toEqual([1, 2, 4, 6, 7, 8, 9, 10, 11, 12]);
	});

	it('reaches the same end as one unbudgeted call, one bounded call at a time', async () => {
		const deployment = await twoReorgsOneFarBelowTheTip();

		let calls = 0;
		for (;;) {
			const report = await compact(deployment, {compaction: DEPTH, maxPairs: 1});
			calls++;
			if (report.complete) break;
			if (calls > 10) throw new Error('the budgeted loop never reported itself complete');
		}

		expect((await rowsOf(deployment.db)).map((row) => row.seq)).toEqual([1, 2, 7, 8, 9, 10, 11, 12]);
	});

	it('refuses a budget that is not a whole number of pairs', async () => {
		const deployment = await twoReorgsOneFarBelowTheTip();

		await expect(compact(deployment, {compaction: DEPTH, maxPairs: 0})).rejects.toThrow(/maxPairs/);
		await expect(compact(deployment, {compaction: DEPTH, maxPairs: 1.5})).rejects.toThrow(/maxPairs/);
	});

	it('refuses a tip that is not a block number, rather than compacting against it', async () => {
		const deployment = await twoReorgsOneFarBelowTheTip();

		await expect(compact(deployment, {compaction: DEPTH, latestBlock: -1})).rejects.toThrow(/latestBlock/);
	});
});

describe('the CANONICAL view answers identically before and after, which is why this is safe', () => {
	it('serves a byte-identical response over the same gate', async () => {
		const deployment = await twoReorgsOneFarBelowTheTip();
		const before = await readCanonical(deployment, 'alpha', {gate: TIP});

		const report = await compact(deployment, {compaction: DEPTH});
		expect(report.rowsDeleted).toBeGreaterThan(0);

		const after = await readCanonical(deployment, 'alpha', {gate: TIP});
		expect(after.status).toBe(before.status);
		// BYTE-identical, cursor included: pair-compaction only ever removes rows this
		// view already excludes (`alive = 0`), so no gated read can change
		expect(after.text).toBe(before.text);
	});

	it('serves a byte-identical response at every gate, including gates inside the compacted range', async () => {
		const deployment = await twoReorgsOneFarBelowTheTip();
		const gates = [100, 105, 107, 109, 150, 199, TIP];
		const before = [];
		for (const gate of gates) before.push((await readCanonical(deployment, 'alpha', {gate})).text);

		await compact(deployment, {compaction: DEPTH});

		for (let i = 0; i < gates.length; i++) {
			expect((await readCanonical(deployment, 'alpha', {gate: gates[i] as number})).text).toBe(before[i]);
		}
	});
});

describe('a consumer inside the window still gets its REWIND after a compaction', () => {
	type CanonicalBody = {
		success: boolean;
		cursor?: string;
		error?: string;
		forkBlock?: number;
	};

	it('names the fork block of a reorg that happened after the compaction', async () => {
		const deployment = await twoReorgsOneFarBelowTheTip();
		await compact(deployment, {compaction: DEPTH});

		// the chain runs on, and a consumer catches up to the tip: its cursor is minted
		// AFTER the compaction, and marked at the stream's high-water seq
		await post(deployment, 'alpha', batchOf(deployment, 'alpha', 202, 210, 210, [transfer(208, '0xa208', ALICE, 10n)]));
		const caughtUp = await readCanonical<CanonicalBody>(deployment, 'alpha', {gate: 210});
		expect(caughtUp.status).toBe(200);

		// and THEN block 208 is replaced
		await post(deployment, 'alpha', batchOf(deployment, 'alpha', 207, 212, 212, [transfer(208, '0xb208', BOB, 11n)]));

		const refused = await readCanonical<CanonicalBody>(deployment, 'alpha', {
			gate: 212,
			cursor: caughtUp.body.cursor as string,
		});
		expect(refused.status).toBe(409);
		expect(refused.body.error).toBe('rewind-required');
		// the reclaimed pairs at 106 and 108 are not the fork, and their absence does not
		// move the answer: the fork is the reorg this consumer actually missed
		expect(refused.body.forkBlock).toBe(208);
	});
});

describe('a seq-stream consumer follows the HOLES compaction leaves', () => {
	type Entry = {removed: boolean; blockNumber: number; blockHash: string};

	it('reaches every surviving entry with nothing skipped and no stall, at a page smaller than the hole', async () => {
		const deployment = await twoReorgsOneFarBelowTheTip();
		const before = await followFeed<Entry>(deployment, 'alpha', 1);
		expect(before.entries).toHaveLength(12);

		await compact(deployment, {compaction: DEPTH});

		// the hole is four seq values wide and the page is one: the case an
		// incrementing consumer stalls on
		const after = await followFeed<Entry>(deployment, 'alpha', 1);
		expect(after.entries.map((entry) => `${entry.blockNumber} ${entry.blockHash} ${entry.removed}`)).toEqual([
			'101 0xa101 false',
			'103 0xa103 false',
			'106 0xb106 false',
			'108 0xb108 false',
			'150 0xa150 false',
			'199 0xa199 false',
			'199 0xa199 true',
			'199 0xb199 false',
		]);
		// exactly the entries it had before, minus the two pairs that were reclaimed
		expect(after.entries).toHaveLength(before.entries.length - 4);
	});

	it('does not repeat an entry when a consumer resumes across a hole', async () => {
		const deployment = await twoReorgsOneFarBelowTheTip();
		await compact(deployment, {compaction: DEPTH});

		for (const limit of [1, 2, 3, 5, 100]) {
			const followed = await followFeed<Entry>(deployment, 'alpha', limit);
			const identities = followed.entries.map((entry) => `${entry.blockHash}:${entry.removed}`);
			expect(new Set(identities).size).toBe(identities.length);
			expect(identities).toHaveLength(8);
		}
	});
});
