/**
 * What a GENERATION costs in a browser, and what happens when the quota says no.
 *
 * Three questions, in the order they matter:
 *
 *  1. FOOTPRINT   what does one generation (its stream segments plus its state)
 *                 actually occupy, counted as bytes written and record counts?
 *  2. ESTIMATE    is `navigator.storage.estimate()` usable for a cap, or is it
 *                 as quantised and laggy as the sqlite spike found it?
 *  3. ATOMICITY   when a write exceeds the quota MID-TRANSACTION, does IndexedDB
 *                 roll the whole transaction back, or does it leave part of it?
 *
 * (3) is the one that can produce a defect. `a-reconfigure-is-not-an-outage`
 * commits a stream segment and its cursor in ONE `setMany` transaction precisely
 * so a crash cannot separate them; if a quota failure can tear that transaction,
 * the cap has to be enforced BEFORE the write rather than caught after it.
 */
import type {CodeUnderTest, RunResult, Timing} from 'playwright-browser-harness/contract';
import {captureEnv} from 'playwright-browser-harness/contract';
import {get, set, setMany, keys, clear, createStore, type UseStore} from 'idb-keyval';

type Fixture = {lastSync: unknown; eventStream: any[]};

async function fetchFixture(): Promise<Fixture> {
	const response = await fetch('./stratagems-alpha1.stream.json.gz');
	const stream = response.body!.pipeThrough(new DecompressionStream('gzip'));
	return JSON.parse(await new Response(stream).text());
}

/** Segments of at most `sealAfter` events, the shape the storage spec writes. */
function segmentise(fixture: Fixture, repeat: number, sealAfter: number): any[][] {
	const base = fixture.eventStream;
	const span = (base[base.length - 1]?.blockNumber ?? 0) - (base[0]?.blockNumber ?? 0) + 1;
	const out: any[][] = [];
	let cur: any[] = [];
	for (let r = 0; r < repeat; r++) {
		for (const e of base) {
			cur.push(r === 0 ? e : {...e, blockNumber: e.blockNumber + r * span});
			if (cur.length >= sealAfter) {
				out.push(cur);
				cur = [];
			}
		}
	}
	if (cur.length) out.push(cur);
	return out;
}

const estimate = async () => {
	try {
		const e = await navigator.storage.estimate();
		return {quota: e.quota ?? null, usage: e.usage ?? null};
	} catch {
		return {quota: null, usage: null};
	}
};

/**
 * Write one generation: its stream segments, plus a state blob standing in for
 * the fold. The state is sized as a fraction of the stream, which is the shape
 * the sqlite spike measured (a fold over 31k logs produced ~0.6 MB of live rows
 * against 17 MB of events), rather than pretending a real processor ran.
 */
async function writeGeneration(store: UseStore, gen: number, segments: any[][], stateRatio: number) {
	let bytes = 0;
	let records = 0;
	for (let i = 0; i < segments.length; i++) {
		const segKey = `p1/1/filter/g${gen}/seg_${String(i).padStart(6, '0')}`;
		const cursorKey = `p1/1/filter/g${gen}/cursor`;
		const segment = {events: segments[i]};
		const cursor = {lastToBlock: i, unconfirmedBlocks: segments[i].slice(-40)};
		// The spec's atomic commit: segment and cursor in ONE transaction.
		await setMany(
			[
				[segKey, segment],
				[cursorKey, cursor],
			],
			store,
		);
		bytes += JSON.stringify(segment).length + JSON.stringify(cursor).length;
		records += 1;
	}
	const stateRows = Math.max(1, Math.floor(segments.length * stateRatio * 100));
	const state = Array.from({length: stateRows}, (_, i) => ({id: `e${i}`, v: i, s: 'x'.repeat(64)}));
	await set(`p1/1/filter/g${gen}/state`, state, store);
	bytes += JSON.stringify(state).length;
	records += 1;
	return {bytes, records};
}

const cut: CodeUnderTest = {
	name: 'generation-storage-headroom-in-the-browser',

	async run({params}): Promise<RunResult> {
		const mode = params.mode as 'footprint' | 'quota-tear';
		const repeat = (params.repeat as number) ?? 1;
		const sealAfter = (params.sealAfter as number) ?? 1000;
		const maxGenerations = (params.maxGenerations as number) ?? 4;
		const store = createStore('generation-headroom', `s-${params.tag}`);

		const timings: Timing[] = [];
		const errors: string[] = [];
		const results: Record<string, unknown> = {mode, repeat, sealAfter};

		try {
			const t0 = performance.now();
			const fixture = await fetchFixture();
			const segments = segmentise(fixture, repeat, sealAfter);
			timings.push({label: 'build-workload', ms: performance.now() - t0});
			results.segmentCount = segments.length;
			results.eventCount = segments.reduce((n, s) => n + s.length, 0);
			results.estimateBefore = await estimate();

			const generations: unknown[] = [];
			let quotaHit: null | Record<string, unknown> = null;

			for (let g = 0; g < maxGenerations; g++) {
				const t = performance.now();
				try {
					const written = await writeGeneration(store, g, segments, 0.05);
					generations.push({
						generation: g,
						...written,
						ms: performance.now() - t,
						estimate: await estimate(),
						keyCount: (await keys(store)).length,
					});
				} catch (error) {
					// THE INTERESTING BRANCH. A quota failure landed mid-run; the
					// question is whether the transaction that failed tore in half.
					const name = (error as any)?.name ?? 'unknown';
					const all = (await keys(store)) as string[];
					// Detect a TEAR properly. Counting keys cannot: the cursor is ONE
					// key overwritten on every commit, so its count is always 0 or 1
					// while segments accumulate. What identifies the pair is the
					// cursor's VALUE, which records the segment index it was committed
					// with. A commit of [seg_i, cursor{lastToBlock:i}] is all-or-nothing
					// iff the highest surviving segment index equals the cursor's.
					const segIdx = all
						.filter((k) => k.startsWith(`p1/1/filter/g${g}/seg_`))
						.map((k) => Number(k.slice(k.lastIndexOf('_') + 1)));
					const highestSegment = segIdx.length ? Math.max(...segIdx) : -1;
					const cursor = (await get(`p1/1/filter/g${g}/cursor`, store)) as {lastToBlock: number} | undefined;
					const cursorAt = cursor ? cursor.lastToBlock : -1;
					quotaHit = {
						generation: g,
						errorName: name,
						message: String((error as Error)?.message ?? error).slice(0, 300),
						highestSegment,
						cursorAt,
						segmentCount: segIdx.length,
						// Equal => every commit landed whole. Segment ahead of cursor, or
						// cursor ahead of segment, means the failing setMany tore.
						transactionTorn: highestSegment !== cursorAt,
						// Which way it tore, if it did. Cursor-ahead is the dangerous
						// direction: it claims coverage the stream does not hold.
						tearDirection:
							highestSegment === cursorAt ? 'none' : cursorAt > highestSegment ? 'cursor-ahead' : 'segment-ahead',
						estimate: await estimate(),
					};
					break;
				}
			}

			results.generations = generations;
			results.quotaHit = quotaHit;
			results.estimateAfter = await estimate();
			results.totalKeys = (await keys(store)).length;

			if (mode === 'footprint') await clear(store);
		} catch (error) {
			errors.push(String((error as Error)?.stack ?? error));
		}

		return {results, timings, errors, env: captureEnv()};
	},
};

export default cut;
