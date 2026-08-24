/**
 * The light path, in a browser: what does answering an as-of read by replaying
 * immer reverse patches backwards actually cost?
 *
 * This is the same measurement `run/measure-patch-replay.ts` makes in node, run
 * where it would really run. It uses the REAL `@etherfold/js-processor` path,
 * not a model of it: the patches come from the processor's own `finishDraft`
 * hook, and the replay is what `History.reverseBlock` does.
 *
 * Correctness is checked at every depth against the state the processor had at
 * that block. A fast wrong answer is the failure mode that matters here.
 */
import type {CodeUnderTest, Timing} from 'playwright-browser-harness/contract';
import {captureEnv} from 'playwright-browser-harness/contract';
import {fromJSProcessor} from '../../../../packages/js-processor/dist/index.js';
import {applyPatches} from '../../../../packages/js-processor/dist/processor/immer.js';
import {StratagemsIndexerProcessor} from '../../../../packages/conformance-workload-stratagems/vendor/stratagems/js-processor.js';
import {generateEventStream, WORKLOAD_SIZES, type WorkloadSize} from '../src/workload/generate.js';

const FINALITY = 64;
const DEPTHS = [1, 2, 4, 8, 16, 32, 64];

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
	JSON.stringify(sortKeys(value), (_, v) => (typeof v === 'bigint' ? `${v}n` : v));

const cut: CodeUnderTest = {
	name: 'immer-patch-replay',

	async run(ctx) {
		const timings: Timing[] = [];
		const errors: string[] = [];
		const results: Record<string, unknown> = {};
		const size = ((ctx.params as {size?: string}).size ?? 'medium') as WorkloadSize;

		try {
			const blocks = generateEventStream({
				...WORKLOAD_SIZES[size],
				seed: 42,
				includeRewards: true,
				includeForceCells: true,
			});

			const processor = fromJSProcessor(() => StratagemsIndexerProcessor as any)();
			processor.configure(undefined as any);
			await processor.load({chainId: '8453', contracts: []} as any, {finality: FINALITY});

			const snapshots = new Map<number, string>();
			let state: any;
			const indexStarted = performance.now();
			for (const block of blocks) {
				state = await processor.process(block.events as any, {
					context: {source: [], config: '', processor: ''},
					latestBlock: block.number, // the block IS the tip, so patches are kept
					lastFromBlock: block.number,
					lastToBlock: block.number,
					unconfirmedBlocks: [],
				} as any);
				snapshots.set(block.number, canonical(state));
			}
			timings.push({label: 'index-with-patches', ms: performance.now() - indexStarted});

			const history = (processor as any)._json.history as {reversals: Record<string, any[][]>};
			const patchLogBytes = JSON.stringify(history.reversals, (_, v) =>
				typeof v === 'bigint' ? `${v}n` : v,
			).length;
			results.stateBytes = canonical(state).length;
			results.patchLogBytes = patchLogBytes;
			results.blocks = blocks.length;

			const depths: unknown[] = [];
			const tipIndex = blocks.length - 1;
			for (const depth of DEPTHS) {
				if (depth > tipIndex || depth > FINALITY) continue;
				let applied = 0;
				const started = performance.now();
				let rewound: any = state;
				for (let i = tipIndex; i > tipIndex - depth; i--) {
					const lists = history.reversals[blocks[i].hash] ?? [];
					for (let j = lists.length - 1; j >= 0; j--) {
						rewound = applyPatches(rewound, lists[j]);
						applied += lists[j].length;
					}
				}
				const ms = performance.now() - started;
				const target = blocks[tipIndex - depth].number;
				depths.push({
					depth,
					ms: +ms.toFixed(2),
					patches: applied,
					correct: canonical(rewound) === snapshots.get(target),
				});
				timings.push({label: `backwards-replay(depth ${depth})`, ms});
			}
			results.depths = depths;
			results.allCorrect = (depths as {correct: boolean}[]).every((entry) => entry.correct);
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
