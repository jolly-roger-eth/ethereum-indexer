/**
 * How much memory does KEEPING recent states cost, given immer's structural sharing?
 *
 *   node --expose-gc --import tsx run/sharing-probe.ts tip|last256|all
 *
 * The light path currently answers history by replaying reverse patches. The
 * alternative in a structurally-shared world is not to replay anything: hold on
 * to the state objects themselves, and let the shared subtrees pay for it. This
 * measures whether that is affordable, which is the whole question.
 */
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {blocksOf} from '../../../../packages/core/dist/index.js';
import {loadStreamFixture} from '../../../../packages/fs/dist/index.js';
import {fromJSProcessor} from '../../../../packages/js-processor/dist/index.js';
import {StratagemsIndexerProcessor} from '../../../../packages/conformance-workload-stratagems/vendor/stratagems/js-processor.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const blocks = blocksOf(loadStreamFixture(path.join(HERE, '../../../../packages/conformance-workload-stratagems/fixtures/stratagems-alpha1.stream.json.gz'))) as any[];
const mode = process.argv[2] ?? 'tip';

const processor = fromJSProcessor(() => StratagemsIndexerProcessor as any)();
processor.configure(undefined as any);
await processor.load({chainId: '8453', contracts: []} as any, {finality: 64});

const kept: any[] = [];
for (const block of blocks) {
	const state = await processor.process(block.events as any, {
		context: {source: [], config: '', processor: ''},
		latestBlock: block.number,
		lastFromBlock: block.number,
		lastToBlock: block.number,
		unconfirmedBlocks: [],
	} as any);
	if (mode === 'all') kept.push(state);
	else if (mode === 'last256') {
		kept.push(state);
		if (kept.length > 256) kept.shift();
	} else {
		kept.length = 0;
		kept.push(state);
	}
}
global.gc?.();
global.gc?.();
console.log(`${mode}: kept ${kept.length} states, heapUsed ${(process.memoryUsage().heapUsed / 1048576).toFixed(1)} MB`);
