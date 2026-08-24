/**
 * Recompute a golden state from the ORACLE.
 *
 *   pnpm --filter @etherfold/conformance-workload-stratagems regenerate-golden-state [alpha1|base|both]
 *
 * **A diff in the output is a FINDING, not a fixture to update.** The golden
 * states are the states the original stratagems `JSProcessor` computed from the
 * committed streams, so this script recomputing something different means one of
 * two things happened: the vendored oracle stopped being the code that ran on
 * Base, or the replay path underneath it changed what it feeds a processor.
 * Either is worth a note in `work/notes/` before anything is committed.
 *
 * It exists so the goldens are reproducible rather than merely trusted, and it
 * is a SCRIPT rather than a test purely because it WRITES: the recomputation
 * itself is cheap enough that `test/oracle.test.ts` does it on both fixtures on
 * every invocation. What this adds is the deliberate overwrite, for the day a
 * difference has been understood and accepted.
 */
import * as fs from 'node:fs';
import {ALPHA1, BASE_ABANDONED, canonical, firstDifferences, type WorkloadFixture} from '../src/fixtures.js';
import {computeWithOracle} from '../src/oracle.js';

const WHICH = process.argv[2] ?? 'both';
const fixtures: WorkloadFixture[] =
	WHICH === 'alpha1' ? [ALPHA1] : WHICH === 'base' ? [BASE_ABANDONED] : [BASE_ABANDONED, ALPHA1];

let changed = 0;
for (const fixture of fixtures) {
	const started = Date.now();
	const recomputed = canonical(await computeWithOracle(fixture));
	const existing = fs.existsSync(fixture.goldenStatePath)
		? fs.readFileSync(fixture.goldenStatePath, 'utf-8')
		: undefined;
	fs.writeFileSync(fixture.goldenStatePath, recomputed);

	const seconds = ((Date.now() - started) / 1000).toFixed(1);
	if (existing === undefined) {
		console.log(`${fixture.name}: written in ${seconds}s (there was no golden state)`);
	} else if (existing === recomputed) {
		console.log(`${fixture.name}: unchanged, recomputed in ${seconds}s`);
	} else {
		changed++;
		console.log(`${fixture.name}: CHANGED in ${seconds}s. That is a finding, not a fixture update.`);
		for (const line of firstDifferences(existing, recomputed)) console.log(line);
	}
}

process.exit(changed === 0 ? 0 : 1);
