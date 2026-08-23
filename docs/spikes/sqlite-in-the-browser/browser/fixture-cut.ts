/**
 * Replay the CAPTURED Base stream in a real browser, and check it lands on the
 * same state node computed.
 *
 * This is the criterion "a fixture both a node and a browser harness can
 * replay", made true rather than asserted: the file is fetched over HTTP,
 * parsed by `@etherfold/core`'s own `parseStreamFixture` (the same function the
 * node side uses), replayed through the same ported processor, and the state is
 * compared byte for byte against `fixtures/stratagems-base.state.json`, which
 * the ORACLE produced in node.
 *
 * Two runtimes, one input, one output. If that ever stops holding, the fixture
 * has stopped being a fixture.
 */
import type {CodeUnderTest, Timing} from 'playwright-browser-harness/contract';
import {captureEnv} from 'playwright-browser-harness/contract';
import {blocksOf} from '../../../../packages/core/dist/stream/fixture.js';
import {fetchStreamFixture} from '../src/workload/load-fixture.js';
import {MemoryBlockStore} from '../src/store/memory.js';
import {IdbBlockStore} from '../src/store/idb.js';
import {runPortOverBlocks} from '../src/port/run-port.js';
import {projectToData} from '../src/port/project.js';

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
const canonical = (value: unknown) =>
	JSON.stringify(sortKeys(value), (_, v) => (typeof v === 'bigint' ? `${v}n` : v), 2);

const cut: CodeUnderTest = {
	name: 'captured-fixture-replay',

	async run(ctx) {
		const timings: Timing[] = [];
		const errors: string[] = [];
		const results: Record<string, unknown> = {};

		try {
			const fetchStarted = performance.now();
			const fixture = await fetchStreamFixture('./stratagems-alpha1.stream.json.gz');
			timings.push({label: 'fetch+parse-fixture', ms: performance.now() - fetchStarted});

			const blocks = blocksOf(fixture);
			results.events = fixture.eventStream.length;
			results.blocks = blocks.length;
			results.provenance = fixture.provenance;

			const reference = new MemoryBlockStore({kind: 'unbounded'});
			await reference.open();
			const replayStarted = performance.now();
			const run = await runPortOverBlocks(reference, blocks as any);
			timings.push({label: 'replay-through-port', ms: performance.now() - replayStarted});
			results.mutations = run.trace.reduce((sum, update) => sum + update.mutations.length, 0);
			results.handlerCalls = run.handlerCalls;

			// The golden state, computed in node BY THE ORIGINAL PROCESSOR.
			const golden = await (await fetch('./stratagems-alpha1.state.json')).text();
			const here = canonical(projectToData(reference));
			results.matchesGoldenState = here.trim() === golden.trim();
			if (!results.matchesGoldenState) {
				const left = golden.trim().split('\n');
				const right = here.split('\n');
				results.firstDifference = left.findIndex((line, index) => line !== right[index]);
				results.goldenLine = left[results.firstDifference as number];
				results.browserLine = right[results.firstDifference as number];
			}

			// And the same trace through a persistent backend, so the fixture is
			// exercised end to end in the browser rather than only in memory.
			const idb = new IdbBlockStore(`spike-sqlite-fixture-${ctx.phase}-${Date.now()}`);
			await idb.open();
			for (const update of run.trace) await idb.applyBlock(update);
			const sample = reference.liveRows();
			let mismatches = 0;
			for (const row of sample) {
				const id: Record<string, string> = {};
				for (const part of row.id.split('|')) {
					const [name, ...rest] = part.split('=');
					id[name] = rest.join('=');
				}
				const stored = await idb.get(row.entity, id);
				if (!stored) {
					mismatches++;
					continue;
				}
				for (const [field, value] of Object.entries(row.values)) {
					if (String(stored[field]) !== String(value)) mismatches++;
				}
			}
			results.liveRows = sample.length;
			results.idbMismatches = mismatches;
			await idb.close();
		} catch (error) {
			const thrown = error as Error;
			errors.push(
				[[thrown?.name, thrown?.message].filter(Boolean).join(': ') || String(error), thrown?.stack]
					.filter(Boolean)
					.join(' | '),
			);
		}

		return {results, timings, errors, env: captureEnv()};
	},
};

export default cut;
