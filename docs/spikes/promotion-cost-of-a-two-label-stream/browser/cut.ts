/**
 * The code under test: one promotion, one layout, in a real browser's IndexedDB.
 *
 * The port is `idb-keyval` because that is what `packages/browser/src/storage/
 * stream/OnIndexedDB.ts` uses. The keeper imports only `get`/`set`/`del`; this
 * also uses `keys`/`getMany`/`setMany`/`delMany`, which the same package ships
 * and which the design record established are available (idb-keyval 6.2.4
 * exports `get set del keys getMany setMany delMany entries values update clear`).
 *
 * IndexedDB has NO rename, which is the point: a key-label relabel here cannot
 * be a metadata operation and degrades to read-plus-write. Whether that makes it
 * cost the same as a value-label rewrite is the question the browser half of
 * this spike exists to answer.
 *
 * Building the stream is OUTSIDE every timed section. It is the backfill that
 * already happened, identical for every arm, and timing it would measure the
 * append rather than the promotion.
 */
import type {CodeUnderTest, RunResult, Timing} from 'playwright-browser-harness/contract';
import {captureEnv} from 'playwright-browser-harness/contract';
import {get, set, del, keys, getMany, setMany, delMany, createStore, clear} from 'idb-keyval';
import {keyLabelLayout, valueLabelLayout, type Layout, type StorePort} from '../src/layouts.js';
import {GRAFT_FRACTION, REPEATS, segmentise, type SharingCase, type Size} from '../src/workload.js';

type Arm = 'key-label' | 'key-label-unbatched' | 'value-label' | 'value-label+pointer';

/** A fresh store per run, so no arm inherits another's rows or another's fragmentation. */
function portFor(storeName: string): StorePort & {ops: number} {
	const store = createStore('promotion-spike', storeName);
	const state = {ops: 0};
	return {
		get ops() {
			return state.ops;
		},
		async keys() {
			return (await keys(store)) as string[];
		},
		async get(key) {
			state.ops++;
			return get(key, store);
		},
		async set(key, value) {
			state.ops++;
			return set(key, value, store);
		},
		async del(key) {
			state.ops++;
			return del(key, store);
		},
		async getMany(ks) {
			state.ops++;
			return getMany(ks, store);
		},
		async setMany(entries) {
			state.ops++;
			return setMany(entries as [string, any][], store);
		},
		async delMany(ks) {
			state.ops++;
			return delMany(ks, store);
		},
	};
}

/**
 * The unbatched key-label arm exists to separate two costs that batching mixes.
 *
 * `getMany`/`setMany`/`delMany` collapse a promotion into three transactions,
 * so the batched arm measures mostly STRUCTURED CLONE. Withholding them makes it
 * three transactions PER SEGMENT, which measures the transaction floor as well.
 * If the two are close, the cost is the clone and no amount of batching helps.
 */
function unbatched(port: StorePort & {ops: number}): StorePort & {ops: number} {
	return {
		get ops() {
			return port.ops;
		},
		keys: port.keys.bind(port),
		get: port.get.bind(port),
		set: port.set.bind(port),
		del: port.del.bind(port),
	} as StorePort & {ops: number};
}

function layoutFor(arm: Arm, port: StorePort, stream: string): Layout {
	switch (arm) {
		case 'key-label':
		case 'key-label-unbatched':
			return keyLabelLayout(port, stream);
		case 'value-label':
			return valueLabelLayout(port, stream);
		case 'value-label+pointer':
			return valueLabelLayout(port, stream, {pointer: true});
	}
}

async function fetchFixture(): Promise<{lastSync: unknown; eventStream: any[]}> {
	const response = await fetch('./stratagems-alpha1.stream.json.gz');
	const stream = response.body!.pipeThrough(new DecompressionStream('gzip'));
	return JSON.parse(await new Response(stream).text());
}

const cut: CodeUnderTest = {
	name: 'promotion-cost-of-a-two-label-stream',

	async run({params}): Promise<RunResult> {
		const arm = params.arm as Arm;
		const size = params.size as Size;
		const sealAfter = params.sealAfter as number;
		const sharingCase = params.sharingCase as SharingCase;
		const storeName = `s-${params.tag}`;

		const timings: Timing[] = [];
		const errors: string[] = [];
		const results: Record<string, unknown> = {arm, size, sealAfter, sharingCase};

		try {
			const t0 = performance.now();
			const fixture = await fetchFixture();
			const segments = segmentise(fixture, REPEATS[size], sealAfter);
			timings.push({label: 'build-workload', ms: performance.now() - t0});

			const base = portFor(storeName);
			const port = arm === 'key-label-unbatched' ? unbatched(base) : base;
			const layout = layoutFor(arm, port, 'stream_tag_1');

			const graftAt = Math.floor((segments.length - 1) * GRAFT_FRACTION[sharingCase]);
			const stagingSegments = segments.length - 1 - graftAt;

			const tWrite = performance.now();
			for (let i = 0; i < segments.length; i++) await layout.append('live', i, segments[i]);
			const startAt = layout.name === 'key-label' ? graftAt + 1 : segments.length;
			for (let i = 0; i < stagingSegments; i++) {
				await layout.append('staging', startAt + i, segments[graftAt + 1 + i]);
			}
			timings.push({label: 'setup-append', ms: performance.now() - tWrite});

			const opsBefore = port.ops;
			const tPromote = performance.now();
			const cost = await layout.promote(graftAt);
			const promoteMs = performance.now() - tPromote;
			timings.push({label: 'promote', ms: promoteMs});

			// Correctness, after the timed section: the promoted stream must read
			// back as one contiguous live generation of the right length.
			const readOrder = await layout.readOrder('live', graftAt);

			results.segments = {live: segments.length, staging: stagingSegments};
			results.streamBytes = segments.reduce((n, s) => n + JSON.stringify(s).length, 0);
			results.promotion = {...cost, ms: promoteMs, storeOpsObserved: port.ops - opsBefore};
			results.readOrderLength = readOrder.length;
			results.expectedReadOrderLength = graftAt + 1 + stagingSegments;
			results.readOrderCorrect = readOrder.length === graftAt + 1 + stagingSegments;

			await clear(createStore('promotion-spike', storeName));
		} catch (error) {
			errors.push(String((error as Error)?.stack ?? error));
		}

		return {results, timings, errors, env: captureEnv()};
	},
};

export default cut;
