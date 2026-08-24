/**
 * The light path: can immer reverse patches answer an as-of read, and what does
 * it cost at depth?
 *
 *   npx tsx run/measure-patch-replay.ts
 *
 * This is the spec's SECOND open question, and it is a question about a real
 * mechanism, not a hypothetical one: `@etherfold/js-processor` already records
 * a reverse patch per block and already keeps them to the finality depth. So
 * the measurement is of the code that exists.
 *
 * For each depth d it replays the last d blocks' reverse patches backwards from
 * the tip, times it, AND checks the result against the state the processor
 * actually had at that block. A cost with no correctness check would be worth
 * nothing: the interesting failure mode is a backwards replay that is fast and
 * WRONG.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {blocksOf, bnReplacer} from '../../../../packages/core/dist/index.js';
import {loadStreamFixture} from '../../../../packages/fs/dist/index.js';
import {fromJSProcessor} from '../../../../packages/js-processor/dist/index.js';
import {applyPatches} from '../../../../packages/js-processor/dist/processor/immer.js';
import {StratagemsIndexerProcessor, type Data} from '../../../../packages/conformance-workload-stratagems/vendor/stratagems/js-processor.js';
import {generateEventStream, WORKLOAD_SIZES, type WorkloadSize} from '../src/workload/generate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(HERE, '../results');

/** The finality depth the window is kept to. 64 blocks is the L1 number this repo's docs use. */
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
const canonical = (value: unknown) => JSON.stringify(sortKeys(value), bnReplacer);

type Measured = {
	size: string;
	blocks: number;
	liveKeys: number;
	stateBytes: number;
	patchLogBytes: number;
	patchesPerBlock: number;
	/** How far apart the event-bearing blocks are. This is what decides the light path's reach. */
	blockGaps: {min: number; median: number; max: number};
	blocksWithRetainedPatches: number;
	depths: {
		depth: number;
		ms: number;
		correct: boolean;
		patchesApplied: number;
		/** False when some block in the range had its reversal pruned before we asked. */
		patchesAvailable: boolean;
	}[];
};

const measurements: Measured[] = [];

// `real` is the captured launched game; the other two are generated. The real
// one is the number to quote, and the generated ones say how the cost moves
// with a workload that is denser per block than the chain actually was.
for (const size of ['real', 'small', 'medium'] as (WorkloadSize | 'real')[]) {
	const blocks =
		size === 'real'
			? (blocksOf(loadStreamFixture(path.join(HERE, '../../../../packages/conformance-workload-stratagems/fixtures/stratagems-alpha1.stream.json.gz'))) as any[])
			: generateEventStream({...WORKLOAD_SIZES[size], seed: 42, includeRewards: true, includeForceCells: true});

	const oracle = fromJSProcessor(() => StratagemsIndexerProcessor as any)();
	oracle.configure(undefined as any);
	await oracle.load({chainId: '8453', contracts: []} as any, {finality: FINALITY});

	// A canonical snapshot after every block, so a backwards replay has something
	// truthful to be checked against.
	const snapshots = new Map<number, string>();
	let state: Data | undefined;
	for (const block of blocks) {
		state = (await oracle.process(block.events as any, {
			context: {source: [], config: '', processor: ''},
			latestBlock: block.number, // 'live': the block IS the tip, so patches are kept
			lastFromBlock: block.number,
			lastToBlock: block.number,
			unconfirmedBlocks: [],
		} as any)) as Data;
		snapshots.set(block.number, canonical(state));
	}
	if (!state) throw new Error('no state');

	const history = (oracle as any)._json.history as {
		reversals: Record<string, any[][]>;
		blockHashes: Record<number, string>;
	};

	const tipIndex = blocks.length - 1;
	const patchLogBytes = JSON.stringify(history.reversals, bnReplacer).length;
	const patchCount = Object.values(history.reversals).reduce(
		(sum, lists) => sum + lists.reduce((inner, list) => inner + list.length, 0),
		0,
	);

	const depths: Measured['depths'] = [];
	for (const depth of DEPTHS) {
		if (depth > blocks.length - 1 || depth > FINALITY) continue;
		const target = blocks[tipIndex - depth];

		// Replay backwards from the tip, exactly as `History.reverseBlock` does:
		// each block's patch lists applied in reverse order.
		//
		// `patchesAvailable` is tracked SEPARATELY from `correct`, because the two
		// failures are completely different things. A wrong answer with every patch
		// present would be a bug in the replay. A wrong answer with patches MISSING
		// is the history having been pruned before we asked, which is the honest
		// limit of the mechanism and the thing worth reporting.
		let applied = 0;
		let available = true;
		const started = performance.now();
		let rewound: any = state;
		for (let i = tipIndex; i > tipIndex - depth; i--) {
			const lists = history.reversals[blocks[i].hash];
			if (!lists) {
				available = false;
				continue;
			}
			for (let j = lists.length - 1; j >= 0; j--) {
				rewound = applyPatches(rewound, lists[j]);
				applied += lists[j].length;
			}
		}
		const ms = performance.now() - started;

		depths.push({
			depth,
			ms: +ms.toFixed(3),
			correct: canonical(rewound) === snapshots.get(target.number),
			patchesApplied: applied,
			patchesAvailable: available,
		});
	}

	// The gaps between event-bearing blocks. `History` prunes by BLOCK NUMBER
	// difference against the finality depth, so on a sparse stream one event-block
	// can be thousands of block numbers past the previous one and prune it.
	const gaps: number[] = [];
	for (let i = 1; i < blocks.length; i++) gaps.push(blocks[i].number - blocks[i - 1].number);
	gaps.sort((a, b) => a - b);

	const stateBytes = canonical(state).length;
	measurements.push({
		size,
		blocks: blocks.length,
		blockGaps: {min: gaps[0] ?? 0, median: gaps[gaps.length >> 1] ?? 0, max: gaps[gaps.length - 1] ?? 0},
		blocksWithRetainedPatches: Object.keys(history.reversals).length,
		liveKeys:
			Object.keys(state.cells).length +
			Object.keys(state.owners).length +
			Object.keys(state.computedPoints).length +
			Object.keys(state.commitments).length,
		stateBytes,
		patchLogBytes,
		patchesPerBlock: +(patchCount / blocks.length).toFixed(1),
		depths,
	});

	console.log(
		`${size}: ${blocks.length} event-bearing blocks, gaps min/median/max ` +
			`${gaps[0] ?? 0}/${gaps[gaps.length >> 1] ?? 0}/${gaps[gaps.length - 1] ?? 0}, ` +
			`state ${(stateBytes / 1024).toFixed(1)} KB, patch log ${(patchLogBytes / 1024).toFixed(1)} KB ` +
			`(${((100 * patchLogBytes) / stateBytes).toFixed(0)}% of state), ` +
			`${Object.keys(history.reversals).length} blocks still have reversals`,
	);
	for (const entry of depths) {
		console.log(
			`  depth ${entry.depth}: ${entry.ms} ms, ${entry.patchesApplied} patches, ` +
				`${entry.patchesAvailable ? 'all patches present' : 'PATCHES PRUNED'}, correct=${entry.correct}`,
		);
	}
}

fs.mkdirSync(RESULTS, {recursive: true});
fs.writeFileSync(
	path.join(RESULTS, 'patch-replay.json'),
	JSON.stringify({finality: FINALITY, measurements, node: process.version, ranAt: new Date().toISOString()}, null, 2),
);

// The bar is: wherever the patches were still there, the replay was right.
// A depth whose patches had been pruned is a RESULT (the mechanism's reach),
// not a failure of the replay, so it does not fail the run.
const wrongWithPatches = measurements.flatMap((entry) =>
	entry.depths.filter((depth) => depth.patchesAvailable && !depth.correct).map((depth) => `${entry.size}@${depth.depth}`),
);
const prunedDepths = measurements.flatMap((entry) =>
	entry.depths.filter((depth) => !depth.patchesAvailable).map((depth) => `${entry.size}@${depth.depth}`),
);
console.log(
	wrongWithPatches.length === 0
		? '\nevery backwards replay with its patches intact matched the recorded state'
		: `\nWRONG DESPITE HAVING THE PATCHES: ${wrongWithPatches.join(', ')}`,
);
if (prunedDepths.length > 0) {
	console.log(`unanswerable because the reversals had been pruned: ${prunedDepths.join(', ')}`);
}
process.exit(wrongWithPatches.length === 0 ? 0 : 1);
