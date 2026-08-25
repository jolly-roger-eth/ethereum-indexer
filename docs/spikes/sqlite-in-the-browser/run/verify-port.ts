/**
 * Does the port produce the SAME STATE as the processor it was ported from?
 *
 *   npx tsx run/verify-port.ts [alpha1|base]
 *
 * `alpha1` (the default) is the LAUNCHED game on Base: 31,332 events over 1,042
 * blocks. `base` is the earlier, abandoned deployment on the same chain, 42
 * events over 9 blocks. Both are real; only one is a workload.
 *
 * Both sides replay the same captured stream with no node in the loop:
 *
 *   oracle: the vendored stratagems `JSProcessor`, verbatim, driven through
 *           `@etherfold/js-processor` exactly as it runs in production.
 *   port:   the `MutationContext` version, writing entity rows.
 *
 * The port's rows are then projected back into the oracle's object shape and
 * compared. An expected value we wrote ourselves would prove nothing; this one
 * was computed by the code that has been running on Base.
 *
 * Outputs (the first two are the PROMOTED conformance workload, and live in
 * `packages/conformance-workload-stratagems/fixtures/` since this spike closed):
 *   stratagems-<deployment>.state.json  the golden state
 *   stratagems-<deployment>.trace.json  the golden per-block mutations
 *   results/port-equality-<deployment>.json  what this run found
 *
 * One thing here is NOT frozen with the rest of the spike: the BigInt encoding.
 * This wrote `"123n"` when the spike closed, and it WRITES the committed golden
 * state, so leaving it would silently un-migrate that file the next time anyone
 * ran it. It uses the repo's one codec (`taggedBnReplacer`) like everything
 * else; see `docs/spikes/tagged-bigint-codec-across-storage-adapters/`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {blocksOf, taggedBnReplacer} from '../../../../packages/core/dist/index.js';
import {loadStreamFixture} from '../../../../packages/fs/dist/index.js';
import {fromJSProcessor} from '../../../../packages/js-processor/dist/index.js';
import {StratagemsIndexerProcessor, type Data} from '../../../../packages/conformance-workload-stratagems/vendor/stratagems/js-processor.js';
import {MemoryBlockStore} from '../src/store/memory.js';
import {projectToData} from '../src/port/project.js';
import {runPortOverBlocks} from '../src/port/run-port.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEPLOYMENT = process.argv[2] ?? 'alpha1';
const FIXTURE = path.join(
	HERE,
	`../../../../packages/conformance-workload-stratagems/fixtures/stratagems-${DEPLOYMENT}.stream.json${DEPLOYMENT === 'base' ? '' : '.gz'}`,
);
const STATE_OUT = path.join(HERE, `../../../../packages/conformance-workload-stratagems/fixtures/stratagems-${DEPLOYMENT}.state.json`);
const TRACE_OUT = path.join(HERE, `../../../../packages/conformance-workload-stratagems/fixtures/stratagems-${DEPLOYMENT}.trace.json`);
const RESULT_OUT = path.join(HERE, `../results/port-equality-${DEPLOYMENT}.json`);

/** Key-sorted JSON, so two objects that differ only in key ORDER compare equal. */
function canonical(value: unknown): string {
	return JSON.stringify(sortKeys(value), taggedBnReplacer, 2);
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value && typeof value === 'object' && !(typeof value === 'bigint')) {
		const record = value as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(record).sort()) out[key] = sortKeys(record[key]);
		return out;
	}
	return value;
}

/** The first N places two canonical renderings diverge, so a failure is readable. */
function firstDifferences(a: string, b: string, limit = 5): string[] {
	const left = a.split('\n');
	const right = b.split('\n');
	const diffs: string[] = [];
	for (let i = 0; i < Math.max(left.length, right.length) && diffs.length < limit; i++) {
		if (left[i] !== right[i]) diffs.push(`line ${i + 1}:\n  oracle: ${left[i]}\n  port:   ${right[i]}`);
	}
	return diffs;
}

const fixture = loadStreamFixture(FIXTURE);
const blocks = blocksOf(fixture);
console.log(
	`fixture: ${fixture.eventStream.length} events in ${blocks.length} blocks ` +
		`(${fixture.provenance.fromBlock} to ${fixture.provenance.toBlock} on chain ${fixture.provenance.chainId})`,
);

// ---------------------------------------------------------------- the oracle
const createProcessor = fromJSProcessor(() => StratagemsIndexerProcessor as any);
const oracle = createProcessor();
oracle.configure(undefined as any);
await oracle.load(fixture.source as any, {finality: 12});
let oracleState: Data | undefined;
for (const block of blocks) {
	oracleState = (await oracle.process(block.events as any, {
		context: fixture.lastSync.context,
		latestBlock: block.number,
		lastFromBlock: block.number,
		lastToBlock: block.number,
		unconfirmedBlocks: [],
	})) as Data;
}
if (!oracleState) throw new Error('the oracle produced no state');

// ------------------------------------------------------------------ the port
const store = new MemoryBlockStore({kind: 'unbounded'});
await store.open();
const run = await runPortOverBlocks(store, blocks as any);
const portState = projectToData(store);

// ------------------------------------------------------------------ compare
const oracleText = canonical(oracleState);
const portText = canonical(portState);
const equal = oracleText === portText;
const diffs = equal ? [] : firstDifferences(oracleText, portText);

const mutationCount = run.trace.reduce((sum, update) => sum + update.mutations.length, 0);
const perEntity: Record<string, number> = {};
for (const update of run.trace) {
	for (const mutation of update.mutations) {
		perEntity[mutation.entity] = (perEntity[mutation.entity] ?? 0) + 1;
	}
}

const result = {
	equal,
	fixture: {
		path: `packages/conformance-workload-stratagems/fixtures/stratagems-${DEPLOYMENT}.stream.json`,
		events: fixture.eventStream.length,
		blocks: blocks.length,
		provenance: fixture.provenance,
	},
	handlerCalls: run.handlerCalls,
	unhandledEvents: run.unhandledEvents,
	mutations: {
		total: mutationCount,
		perBlock: run.trace.map((update) => ({block: update.block.number, mutations: update.mutations.length})),
		perEntity,
	},
	reads: run.stats,
	liveRows: store.liveRows().length,
	versions: store.versionCount(),
	differences: diffs,
	ranAt: new Date().toISOString(),
};

fs.mkdirSync(path.dirname(RESULT_OUT), {recursive: true});
fs.writeFileSync(RESULT_OUT, JSON.stringify(result, taggedBnReplacer, 2));
fs.writeFileSync(STATE_OUT, canonical(oracleState));
fs.writeFileSync(TRACE_OUT, JSON.stringify({trace: run.trace}, taggedBnReplacer, 2));

console.log(`handlers fired: ${JSON.stringify(run.handlerCalls)}`);
console.log(`events with no handler: ${JSON.stringify(run.unhandledEvents)}`);
console.log(`mutations: ${mutationCount} across ${run.trace.length} blocks, per entity ${JSON.stringify(perEntity)}`);
console.log(`reads: ${JSON.stringify(run.stats)}`);
console.log(equal ? '\nEQUAL: the port produces the same state as the JSProcessor.' : '\nDIFFERENT:');
for (const diff of diffs) console.log(diff);
process.exit(equal ? 0 : 1);
