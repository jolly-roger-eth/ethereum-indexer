/**
 * The code under test: one storage candidate, one workload size, in a real
 * browser.
 *
 * Every candidate gets the SAME trace, generated in-page from the same seed by
 * the same real processor, so nothing is compared against a different input.
 * Trace generation is deliberately OUTSIDE every timed section: it is processor
 * work, identical for all candidates, and folding it in would flatter whichever
 * backend happened to run first.
 */
import type {CodeUnderTest, Timing} from 'playwright-browser-harness/contract';
import {captureEnv} from 'playwright-browser-harness/contract';
import {blocksOf} from '../../../../packages/core/dist/stream/fixture.js';
import {fetchStreamFixture} from '../src/workload/load-fixture.js';
import {MemoryBlockStore} from '../src/store/memory.js';
import {IdbBlockStore, deleteDatabase} from '../src/store/idb.js';
import {BlobBlockStore} from '../src/store/blob.js';
import {SqliteWorkerStore, type SqliteVfs} from '../src/store/sqlite-proxy.js';
import {runPortOverBlocks} from '../src/port/run-port.js';
import {generateEventStream, WORKLOAD_SIZES, type WorkloadSize} from '../src/workload/generate.js';
import type {BlockStore, BlockUpdate, EntityId} from '../src/store/types.js';

type BackendName =
	| 'memory'
	| 'idb-versioned'
	| 'idb-versioned-cached'
	| 'blob-structured-clone'
	| 'blob-json'
	| 'sqlite-opfs'
	| 'sqlite-opfs-sahpool';

const DB_PREFIX = 'spike-sqlite';

/**
 * `real` is the captured launched game, replayed through the port in-page; every
 * other size is generated. Both paths end in the same place, a `BlockUpdate[]`
 * the real processor produced, so no backend can tell which it is being fed.
 */
async function buildTrace(size: WorkloadSize | 'real'): Promise<{trace: BlockUpdate[]; reference: MemoryBlockStore}> {
	const blocks =
		size === 'real'
			? blocksOf(await fetchStreamFixture('./stratagems-alpha1.stream.json.gz'))
			: generateEventStream({
					...WORKLOAD_SIZES[size],
					seed: 42,
					includeRewards: true,
					includeForceCells: true,
				});
	const reference = new MemoryBlockStore({kind: 'unbounded'});
	await reference.open();
	const run = await runPortOverBlocks(reference, blocks as any);
	return {trace: run.trace, reference};
}

/** A fixed, seeded sample of live rows: every candidate reads the same ones. */
function sampleIds(reference: MemoryBlockStore, count: number): {entity: string; id: EntityId}[] {
	const rows = reference.liveRows();
	const picked: {entity: string; id: EntityId}[] = [];
	if (rows.length === 0) return picked;
	const stride = Math.max(1, Math.floor(rows.length / count));
	for (let i = 0; i < rows.length && picked.length < count; i += stride) {
		const row = rows[i];
		const id: EntityId = {};
		for (const part of row.id.split('|')) {
			const [name, ...rest] = part.split('=');
			id[name] = rest.join('=');
		}
		picked.push({entity: row.entity, id});
	}
	return picked;
}

function makeBackend(backend: BackendName, tag: string): BlockStore {
	switch (backend) {
		case 'memory':
			return new MemoryBlockStore({kind: 'unbounded'});
		case 'idb-versioned':
			return new IdbBlockStore(`${DB_PREFIX}-idb-${tag}`);
		case 'idb-versioned-cached':
			return new IdbBlockStore(`${DB_PREFIX}-idb-${tag}`, {kind: 'unbounded'}, 'idb-versioned-cached', true);
		case 'blob-structured-clone':
			return new BlobBlockStore(`${DB_PREFIX}-blob-sc-${tag}`, 'structured-clone');
		case 'blob-json':
			return new BlobBlockStore(`${DB_PREFIX}-blob-json-${tag}`, 'json');
		case 'sqlite-opfs':
		case 'sqlite-opfs-sahpool': {
			const vfs: SqliteVfs = backend === 'sqlite-opfs' ? 'opfs' : 'opfs-sahpool';
			return new SqliteWorkerStore(new URL('./worker.js', location.href), vfs, `${tag}.sqlite3`, {
				kind: 'unbounded',
			});
		}
	}
}

async function storageUsed(): Promise<number | undefined> {
	try {
		const estimate = await navigator.storage?.estimate?.();
		return estimate?.usage;
	} catch {
		return undefined;
	}
}

const cut: CodeUnderTest = {
	name: 'etherfold-storage-candidates',

	async run(ctx) {
		const timings: Timing[] = [];
		const errors: string[] = [];
		const results: Record<string, unknown> = {};
		const params = ctx.params as {
			backend: BackendName;
			size: WorkloadSize | 'real';
			tag?: string;
			reads?: number;
			asOfDepth?: number;
			revertDepth?: number;
		};
		const backendName = params.backend;
		const size = params.size;
		const tag = params.tag ?? `${backendName}-${size}`;
		const readCount = params.reads ?? 200;

		try {
			const traceStarted = performance.now();
			const {trace, reference} = await buildTrace(size);
			timings.push({label: 'build-trace(untimed for candidates)', ms: performance.now() - traceStarted});

			const mutations = trace.reduce((sum, update) => sum + update.mutations.length, 0);
			results.blocks = trace.length;
			results.mutations = mutations;
			results.liveRows = reference.liveRows().length;
			results.versions = reference.versionCount();

			const usedBefore = await storageUsed();
			const store = makeBackend(backendName, tag);

			// COLD START: open, and for a persistent backend that means whatever it
			// has to do before it can answer anything (wasm init, OPFS open, DDL).
			const openStarted = performance.now();
			await store.open();
			const openMs = performance.now() - openStarted;
			timings.push({label: 'open', ms: openMs});
			if (store instanceof SqliteWorkerStore) {
				results.vfsUsed = store.vfsUsed;
				results.openBreakdown = store.openTimings;
			}

			if (ctx.phase === 'read') {
				// After a reload: did it survive, and how long to the first answer?
				// For the incumbent, "open" is only half of it: the whole state has to be
				// read back and revived before the first question can be answered, and
				// that cost grows with total state. Timing it here is the point.
				if (store instanceof BlobBlockStore) {
					const loadStarted = performance.now();
					results.blobRowsLoaded = await store.load();
					timings.push({label: 'load-whole-blob', ms: performance.now() - loadStarted});
				}
				const sample = sampleIds(reference, 10);
				const firstStarted = performance.now();
				const first = sample.length > 0 ? await store.get(sample[0].entity, sample[0].id) : undefined;
				timings.push({label: 'first-read-after-reload', ms: performance.now() - firstStarted});
				let survived = 0;
				for (const one of sample) {
					if (await store.get(one.entity, one.id)) survived++;
				}
				results.survived = survived === sample.length && sample.length > 0;
				results.survivedRows = survived;
				results.sampled = sample.length;
				results.firstRow = first ? Object.keys(first).length : 0;
				await store.close();
				return {results, timings, errors, env: captureEnv()};
			}

			// WRITE: one block, one batch. For the worker-backed candidate the loop
			// runs inside the worker, so the number is storage rather than messaging.
			let writeMs: number;
			let perBlock: number[];
			if (store instanceof SqliteWorkerStore) {
				const applied = await store.applyBlocksTimed(trace);
				writeMs = applied.ms;
				perBlock = applied.perBlock;
			} else {
				perBlock = [];
				const started = performance.now();
				for (const update of trace) {
					const blockStarted = performance.now();
					await store.applyBlock(update);
					perBlock.push(performance.now() - blockStarted);
				}
				writeMs = performance.now() - started;
			}
			timings.push({label: 'write-all-blocks', ms: writeMs});

			// The COST CURVE: cost per block against how much is already stored, taken
			// inside ONE warm run. This is what a crossover is actually visible in; a
			// single average per size hides it, because it mixes an empty store with a
			// full one.
			const buckets = 10;
			const perBucket = Math.max(1, Math.ceil(perBlock.length / buckets));
			const curve: {fromBlock: number; blocks: number; rowsBefore: number; msPerBlock: number; msPerMutation: number}[] =
				[];
			let rowsSoFar = 0;
			for (let start = 0; start < perBlock.length; start += perBucket) {
				const slice = perBlock.slice(start, start + perBucket);
				const mutationsHere = trace
					.slice(start, start + perBucket)
					.reduce((sum, update) => sum + update.mutations.length, 0);
				const total = slice.reduce((sum, ms) => sum + ms, 0);
				curve.push({
					fromBlock: start,
					blocks: slice.length,
					rowsBefore: rowsSoFar,
					msPerBlock: +(total / slice.length).toFixed(3),
					msPerMutation: +((total * 1000) / Math.max(1, mutationsHere)).toFixed(1) / 1000,
				});
				rowsSoFar += mutationsHere;
			}
			results.writeCurve = curve;
			results.blocksPerSecond = +(trace.length / (writeMs / 1000)).toFixed(1);
			results.rowsPerSecond = +(mutations / (writeMs / 1000)).toFixed(1);
			results.msPerBlock = +(writeMs / trace.length).toFixed(3);

			// POINT READS at the tip.
			const sample = sampleIds(reference, readCount);
			let readMs: number;
			if (store instanceof SqliteWorkerStore) {
				readMs = (await store.getManyTimed(sample)).ms;
			} else {
				const started = performance.now();
				for (const one of sample) await store.get(one.entity, one.id);
				readMs = performance.now() - started;
			}
			timings.push({label: 'point-reads', ms: readMs});
			results.pointReads = sample.length;
			results.msPerPointRead = +(readMs / Math.max(1, sample.length)).toFixed(4);

			// A correctness spot check, so a fast wrong backend cannot pass.
			let wrong = 0;
			for (const one of sample.slice(0, 25)) {
				const expected = await reference.get(one.entity, one.id);
				const actual = await store.get(one.entity, one.id);
				if (!actual) {
					wrong++;
					continue;
				}
				for (const [field, value] of Object.entries(expected ?? {})) {
					if (String(actual[field]) !== String(value)) wrong++;
				}
			}
			results.spotCheckMismatches = wrong;

			// AS-OF at depth, which is the read the light path has to replay for.
			const depth = params.asOfDepth ?? Math.min(64, trace.length - 1);
			const asOfBlock = trace[Math.max(0, trace.length - 1 - depth)].block.number;
			results.asOfDepth = depth;
			try {
				let asOfMs: number;
				if (store instanceof SqliteWorkerStore) {
					asOfMs = (await store.getAsOfManyTimed(sample, asOfBlock)).ms;
				} else {
					const started = performance.now();
					for (const one of sample) await store.getAsOf(one.entity, one.id, asOfBlock);
					asOfMs = performance.now() - started;
				}
				timings.push({label: `as-of(depth ${depth})`, ms: asOfMs});
				results.msPerAsOfRead = +(asOfMs / Math.max(1, sample.length)).toFixed(4);
			} catch (error) {
				results.asOfRefused = `${(error as Error).name}: ${(error as Error).message}`;
			}

			// REVERT: the reorg path, at the depth a reorg actually reaches.
			const revertDepth = params.revertDepth ?? Math.min(8, trace.length - 1);
			try {
				const revertBlock = trace[trace.length - 1 - revertDepth].block.number;
				const started = performance.now();
				await store.revertTo(revertBlock);
				timings.push({label: `revert(${revertDepth} blocks)`, ms: performance.now() - started});
				// Put the reverted blocks back, UNTIMED. Otherwise the persistence check
				// after the reload would be looking for rows this measurement had just
				// undone, and would report a storage failure that is really a benchmark
				// artefact.
				for (const update of trace.slice(trace.length - revertDepth)) await store.applyBlock(update);
				results.revertDepth = revertDepth;
			} catch (error) {
				results.revertRefused = `${(error as Error).message}`;
			}

			// FOOTPRINT AS A FUNCTION OF RETENTION. The versioned backends keep every
			// superseded version; a retention window is what stops that growing without
			// bound, so the interesting number is what each window actually saves.
			const tipBlock = trace[trace.length - 1].block.number;
			const retention: Record<string, unknown> = {};
			if (store instanceof SqliteWorkerStore) {
				retention.unbounded = await store.byteSize();
				for (const window of [1000, 64]) {
					const pruned = await store.prune(tipBlock - window);
					retention[`window-${window}`] = pruned.bytes;
					retention[`window-${window}-pruneMs`] = +pruned.ms.toFixed(1);
				}
			} else if (store instanceof IdbBlockStore) {
				retention.unboundedCounts = await store.counts();
				retention.unboundedEstimate = await storageUsed();
				for (const window of [1000, 64]) {
					const started = performance.now();
					const dropped = await store.prune(tipBlock - window);
					retention[`window-${window}`] = {
						dropped,
						pruneMs: +(performance.now() - started).toFixed(1),
						counts: await store.counts(),
						estimate: await storageUsed(),
					};
				}
			}
			results.retention = retention;

			const usedAfter = await storageUsed();
			results.storageEstimateDelta =
				usedBefore !== undefined && usedAfter !== undefined ? usedAfter - usedBefore : undefined;
			if (store instanceof SqliteWorkerStore) results.sqliteBytes = await store.byteSize();
			if (store instanceof IdbBlockStore) results.idbCounts = await store.counts();
			if (store instanceof BlobBlockStore) results.blobBytes = store.lastBytes;

			await store.close();
		} catch (error) {
			// NOT `error.stack ?? error.message`: WebKit's `stack` does NOT include the
			// message, so that form reports a bare stack line and loses what actually
			// went wrong, on the one engine where the SQLite route fails hardest.
			const thrown = error as Error;
			errors.push(
				[[thrown?.name, thrown?.message].filter(Boolean).join(': ') || String(error), thrown?.stack]
					.filter(Boolean)
					.join(' | '),
			);
		}

		return {results, timings, errors, env: captureEnv()};
	},

	async reset() {
		for (const name of ['idb', 'blob-sc', 'blob-json']) {
			try {
				const databases = await indexedDB.databases?.();
				for (const database of databases ?? []) {
					if (database.name?.startsWith(`${DB_PREFIX}-${name}`)) await deleteDatabase(database.name);
				}
			} catch {
				// Firefox has no indexedDB.databases(); the per-run tag keeps runs apart anyway.
			}
		}
	},
};

export default cut;
