/**
 * Build the mutation traces the storage candidates replay, and re-check the
 * port against the oracle on a workload that actually exercises it.
 *
 *   npx tsx run/build-traces.ts
 *
 * The captured Base stream fires three handlers. That is enough to prove the
 * port right on real data and not enough to prove it right in general, so this
 * runs BOTH implementations over generated streams that reach every handler,
 * the placement-window eviction, the poke path and the force-cells path, and
 * compares the states again.
 *
 * Outputs:
 *   results/trace-shapes.json   what each workload size costs, in rows and mutations
 *   results/port-equality-synthetic.json
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {bnReplacer} from '../../../../packages/core/dist/index.js';
import {fromJSProcessor} from '../../../../packages/js-processor/dist/index.js';
import {StratagemsIndexerProcessor, type Data} from '../vendor/stratagems/js-processor.js';
import {MemoryBlockStore} from '../src/store/memory.js';
import {projectToData} from '../src/port/project.js';
import {runPortOverBlocks} from '../src/port/run-port.js';
import {generateEventStream, WORKLOAD_SIZES, type WorkloadSize} from '../src/workload/generate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(HERE, '../results');

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value && typeof value === 'object') {
		const record = value as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(record).sort()) out[key] = sortKeys(record[key]);
		return out;
	}
	return value;
}
const canonical = (value: unknown) => JSON.stringify(sortKeys(value), bnReplacer, 2);

async function oracleState(blocks: any[]): Promise<Data> {
	const oracle = fromJSProcessor(() => StratagemsIndexerProcessor as any)();
	oracle.configure(undefined as any);
	await oracle.load({chainId: '8453', contracts: []} as any, {finality: 12});
	let state: Data | undefined;
	for (const block of blocks) {
		state = (await oracle.process(block.events as any, {
			context: {source: [], config: '', processor: ''},
			latestBlock: block.number,
			lastFromBlock: block.number,
			lastToBlock: block.number,
			unconfirmedBlocks: [],
		} as any)) as Data;
	}
	if (!state) throw new Error('no state');
	return state;
}

const shapes: Record<string, unknown> = {};
const equality: Record<string, unknown> = {};

for (const size of Object.keys(WORKLOAD_SIZES) as WorkloadSize[]) {
	const spec = {...WORKLOAD_SIZES[size], seed: 42, includeRewards: true, includeForceCells: true};
	const blocks = generateEventStream(spec);

	const store = new MemoryBlockStore({kind: 'unbounded'});
	await store.open();
	const started = Date.now();
	const run = await runPortOverBlocks(store, blocks as any);
	const portMs = Date.now() - started;

	const mutations = run.trace.reduce((sum, update) => sum + update.mutations.length, 0);
	const perEntity: Record<string, number> = {};
	for (const update of run.trace) {
		for (const mutation of update.mutations) perEntity[mutation.entity] = (perEntity[mutation.entity] ?? 0) + 1;
	}
	const perBlock = run.trace.map((update) => update.mutations.length).sort((a, b) => a - b);

	shapes[size] = {
		spec,
		events: blocks.reduce((sum, block) => sum + block.events.length, 0),
		blocks: blocks.length,
		mutations,
		mutationsPerBlock: {
			min: perBlock[0],
			median: perBlock[perBlock.length >> 1],
			max: perBlock[perBlock.length - 1],
			mean: +(mutations / blocks.length).toFixed(1),
		},
		perEntity,
		liveRows: store.liveRows().length,
		versions: store.versionCount(),
		reads: run.stats,
		handlerCalls: run.handlerCalls,
		portMs,
	};

	// The equality re-check. Only the sizes small enough for the oracle's immer
	// path to finish in reasonable time: the point is COVERAGE, not volume, and
	// coverage is complete by `small`.
	if (size === 'tiny' || size === 'small') {
		const expected = canonical(await oracleState(blocks));
		const actual = canonical(projectToData(store));
		equality[size] = {
			equal: expected === actual,
			handlerCalls: run.handlerCalls,
			liveRows: store.liveRows().length,
		};
		console.log(`${size}: equal=${expected === actual} handlers=${JSON.stringify(run.handlerCalls)}`);
	}

	console.log(
		`${size}: ${blocks.length} blocks, ${mutations} mutations, ${store.liveRows().length} live rows, ` +
			`${store.versionCount()} versions, port ${portMs} ms`,
	);
}

fs.mkdirSync(RESULTS, {recursive: true});
fs.writeFileSync(path.join(RESULTS, 'trace-shapes.json'), JSON.stringify({shapes, ranAt: new Date().toISOString()}, bnReplacer, 2));
fs.writeFileSync(
	path.join(RESULTS, 'port-equality-synthetic.json'),
	JSON.stringify({equality, ranAt: new Date().toISOString()}, bnReplacer, 2),
);

const failed = Object.values(equality).some((entry) => !(entry as {equal: boolean}).equal);
process.exit(failed ? 1 : 0);
