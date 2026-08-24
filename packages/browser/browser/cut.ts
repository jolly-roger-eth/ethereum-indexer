/**
 * The code under test, bundled into a real browser page.
 *
 * What runs here is the WHOLE claim of this package, not a piece of it: an
 * application's entity processor, driven by `createIndexerState`, against a
 * `StateStore` that `createBrowserStateStore` built, in an engine that has real
 * IndexedDB and a real page reload. The node tests
 * (`test/entityIndexing.test.ts`) ask the same questions of the same workload
 * object under `fake-indexeddb`, on every commit; this is where the answers stop
 * depending on a shim.
 *
 * The cases:
 *
 * - `index`: the captured stream through the hook, landing on the expected state.
 * - `reorg`: the same, then a branch that replaces block 104 with fewer events,
 *   so the counter must come DOWN.
 * - `backends`: the SAME processor object on the IndexedDB default and on the
 *   light patch store, compared to each other rather than to a hand-written
 *   answer.
 * - `write` / `read` phases: reload continuity across a REAL page reload, which
 *   is the thing no node test can show. The `read` phase runs in a page that has
 *   never seen the `write` phase's objects; the only thing that crossed is
 *   IndexedDB.
 */
import type {CodeUnderTest, RunContext, RunResult, Timing} from 'playwright-browser-harness/contract';
import {captureEnv, timed} from 'playwright-browser-harness/contract';
import {MemoryStateStore} from '@etherfold/state-store';
import {PatchStateStore} from '@etherfold/state-store-patch';
import {createBrowserStateStore} from '../src/index.js';
import {
	BRANCH_B,
	BRANCH_B_TIP,
	fakeChain,
	FINALITY,
	indexerFor,
	indexToTip,
	processor,
	readState,
	runWorkload,
	SOURCE,
	START_BLOCK,
} from './workload.js';

type Params = Record<string, unknown>;

function databaseName(params: Params, suffix: string): string {
	return `${(params.tag as string) ?? 'etherfold-browser-indexing'}-${suffix}`;
}

/** The captured stream, through the hook, on the default backend. */
async function indexCase(params: Params, timings: Timing[]): Promise<Record<string, unknown>> {
	const store = await createBrowserStateStore(processor.entities, {databaseName: databaseName(params, 'index')});
	const {state, lastSync, ranges} = await timed('index', timings, () => runWorkload(store));
	return {state, lastToBlock: lastSync.lastToBlock, latestBlock: lastSync.latestBlock, ranges};
}

/** A reorg through the browser path, including the counter that must decrease. */
async function reorgCase(params: Params, timings: Timing[]): Promise<Record<string, unknown>> {
	const chain = fakeChain();
	const store = await createBrowserStateStore(processor.entities, {databaseName: databaseName(params, 'reorg')});
	const indexer = indexerFor(store);
	await indexer.init({provider: chain.provider, source: SOURCE, config: {stream: {finality: FINALITY}}});

	await timed('branch-a', timings, () => indexToTip(indexer));
	const before = await readState(indexer.state.$state);

	chain.serve(BRANCH_B, BRANCH_B_TIP);
	await timed('branch-b', timings, () => indexToTip(indexer));
	const after = await readState(indexer.state.$state);

	indexer.dispose();
	return {before, after};
}

/**
 * One processor, two backends the application chose between.
 *
 * The comparison is between the runs, not against a literal: an expectation
 * written here could be wrong in the same way twice, while two stores that were
 * never told about each other agreeing is the claim itself.
 */
async function backendsCase(params: Params, timings: Timing[]): Promise<Record<string, unknown>> {
	const onIndexedDB = await timed('indexeddb', timings, async () =>
		runWorkload(await createBrowserStateStore(processor.entities, {databaseName: databaseName(params, 'backends')})),
	);
	const onPatches = await timed('patch', timings, async () =>
		runWorkload(
			await createBrowserStateStore(processor.entities, {
				backend: (declarations) => new PatchStateStore(declarations, {finalityDepth: FINALITY}),
			}),
		),
	);
	const inMemory = await timed('memory', timings, async () =>
		runWorkload(
			await createBrowserStateStore(processor.entities, {
				backend: (declarations) => new MemoryStateStore(declarations),
			}),
		),
	);

	return {
		indexeddb: onIndexedDB.state,
		patch: onPatches.state,
		memory: inMemory.state,
		// what the light store tells an app author about a reload, BEFORE one happens
		patchDurability: (onPatches.indexer.state.$state.capabilities as {durability?: string}).durability ?? 'unstated',
	};
}

/** The tab indexes, then goes away. */
async function writePhase(params: Params, timings: Timing[]): Promise<Record<string, unknown>> {
	const store = await createBrowserStateStore(processor.entities, {databaseName: databaseName(params, 'reload')});
	const {state, ranges} = await timed('first-tab', timings, () => runWorkload(store));
	return {state, ranges, firstRangeFrom: ranges[0]?.from};
}

/**
 * The tab is opened again: same origin, same database, nothing else in common.
 *
 * The assertion the node side cannot make is that this page really did start
 * cold. Its module instances, its stores and its processor are new; if the
 * cursor had not survived in IndexedDB, this would re-index from
 * `START_BLOCK` and say so in `firstRangeFrom`.
 */
async function readPhase(params: Params, timings: Timing[]): Promise<Record<string, unknown>> {
	const store = await timed('cold-start', timings, () =>
		createBrowserStateStore(processor.entities, {databaseName: databaseName(params, 'reload')}),
	);
	const {state, ranges} = await timed('second-tab', timings, () => runWorkload(store));
	return {state, ranges, firstRangeFrom: ranges[0]?.from, startBlock: START_BLOCK};
}

const cut: CodeUnderTest = {
	name: '@etherfold/browser',
	async run(ctx: RunContext): Promise<RunResult> {
		const timings: Timing[] = [];
		const errors: string[] = [];
		let results: Record<string, unknown> = {};

		try {
			if (ctx.phase === 'write') {
				results = await writePhase(ctx.params, timings);
			} else if (ctx.phase === 'read') {
				results = await readPhase(ctx.params, timings);
			} else {
				switch (ctx.params.case) {
					case 'index':
						results = await indexCase(ctx.params, timings);
						break;
					case 'reorg':
						results = await reorgCase(ctx.params, timings);
						break;
					case 'backends':
						results = await backendsCase(ctx.params, timings);
						break;
					default:
						throw new Error(`unknown case ${JSON.stringify(ctx.params.case)}`);
				}
			}
		} catch (error) {
			errors.push(`${(error as Error)?.stack ?? error}`);
		}

		return {results, timings, errors, env: captureEnv()};
	},
};

export default cut;
