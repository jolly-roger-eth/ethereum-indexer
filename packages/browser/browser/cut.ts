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
 * - `hot-processor` / `hot-contract`: the two reload axes, which are the ones
 *   that only exist because of a DEVELOPMENT loop -- an edited reducer swapped
 *   into a running tab, and a contract redeployed behind a proxy at an address
 *   that already has indexed history. They run here rather than only under
 *   `fake-indexeddb` because a discard is a real `revertTo` against a real
 *   database, followed by a real re-index, in a page that never reloaded.
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
	entityProcessorOver,
	fakeChain,
	FINALITY,
	indexerFor,
	indexerForProcessor,
	indexToTip,
	processor,
	processorVariant,
	readState,
	runWorkload,
	SOURCE,
	SOURCE_V2,
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

/**
 * AXIS ONE: the developer edited the reducer.
 *
 * Three swaps in one page, because the interesting part is that they differ:
 * the same edit is a no-op, a rebuild, or a rebuild, depending only on a string
 * the author controls.
 */
async function hotProcessorCase(params: Params, timings: Timing[]): Promise<Record<string, unknown>> {
	const chain = fakeChain();
	const store = await createBrowserStateStore(processor.entities, {
		databaseName: databaseName(params, 'hot-processor'),
	});
	const indexer = indexerForProcessor(store, processor);
	await indexer.init({provider: chain.provider, source: SOURCE, config: {stream: {finality: FINALITY}}});

	await timed('initial-index', timings, () => indexToTip(indexer));
	const before = await readState(indexer.state.$state);

	// (1) the edit, with `version` left alone: the core cannot see it
	const unbumped = await indexer.updateProcessor({
		kind: 'entities',
		processor: entityProcessorOver(store, processorVariant({version: '1.0.0', countBy: 10})),
	});
	await indexToTip(indexer);
	const afterUnbumped = await readState(indexer.state.$state);

	// (2) the same edit with `version` bumped: discarded and recomputed
	const bumped = await timed('bumped-swap', timings, () =>
		indexer.updateProcessor({
			kind: 'entities',
			processor: entityProcessorOver(store, processorVariant({version: '2.0.0', countBy: 10})),
		}),
	);
	await indexToTip(indexer);
	const afterBumped = await readState(indexer.state.$state);

	indexer.dispose();
	return {
		before,
		unbumpedDiscarded: unbumped.stateDiscarded,
		afterUnbumped,
		bumpedDiscarded: bumped.stateDiscarded,
		afterBumped,
	};
}

/**
 * AXIS TWO: a redeploy behind the proxy, at an address that already has history.
 *
 * The second half is the one worth running in a real engine: the redeployed
 * implementation has emitted NOTHING yet, so there is no event to overwrite the
 * state with. What the page shows afterwards is whatever the hook published at
 * the moment of the discard, and nothing else will ever correct it.
 */
async function hotContractCase(params: Params, timings: Timing[]): Promise<Record<string, unknown>> {
	const chain = fakeChain();
	const store = await createBrowserStateStore(processor.entities, {databaseName: databaseName(params, 'hot-contract')});
	const indexer = indexerForProcessor(store, processor);
	await indexer.init({provider: chain.provider, source: SOURCE, config: {stream: {finality: FINALITY}}});

	await timed('initial-index', timings, () => indexToTip(indexer));
	const before = await readState(indexer.state.$state);
	const rangesBefore = chain.ranges.length;

	// the same address, the ABI a redeployed implementation generates
	const outcome = await timed('redeploy', timings, () => indexer.updateIndexer({source: SOURCE_V2 as never}));
	await indexToTip(indexer);
	const after = await readState(indexer.state.$state);
	const reindexedFrom = chain.ranges.slice(rangesBefore)[0]?.from;

	// The case with no next event to hide the defect: a second tab indexes the
	// same history, then the contract is redeployed and the new implementation has
	// emitted nothing at all. What `$state` holds after this is final.
	const emptyChain = fakeChain();
	const emptyStore = await createBrowserStateStore(processor.entities, {
		databaseName: databaseName(params, 'hot-contract-empty'),
	});
	const second = indexerForProcessor(emptyStore, processor);
	await second.init({provider: emptyChain.provider, source: SOURCE, config: {stream: {finality: FINALITY}}});
	await indexToTip(second);
	const beforeRedeploy = await readState(second.state.$state);

	emptyChain.serve([], 120);
	await second.updateIndexer({source: SOURCE_V2 as never});
	await indexToTip(second);
	const afterEmptyRedeploy = await readState(second.state.$state);

	indexer.dispose();
	second.dispose();
	return {
		before,
		stateDiscarded: outcome.stateDiscarded,
		after,
		reindexedFrom,
		startBlock: START_BLOCK,
		beforeRedeploy,
		afterEmptyRedeploy,
	};
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
					case 'hot-processor':
						results = await hotProcessorCase(ctx.params, timings);
						break;
					case 'hot-contract':
						results = await hotContractCase(ctx.params, timings);
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
