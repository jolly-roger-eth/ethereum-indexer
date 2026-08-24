/**
 * The golden states really are the ORIGINAL processor's output.
 *
 * Without this the vendored oracle is a folder nothing executes, and the claim
 * that makes the whole fixture worth its weight -- "the expected state was
 * computed by the code that has been running on Base, not by a reimplementation"
 * -- would rest on a commit message. Here the oracle is actually run, over the
 * committed streams, through `@etherfold/core`'s own replay path, and the result
 * is compared against the committed files.
 *
 * BOTH fixtures, on every invocation, including the launched game: the oracle is
 * an in-memory immer processor with no store under it, so replaying all 31,332
 * events through it costs about a second and a half, two orders of magnitude
 * less than replaying them through a backend. There is no reason to make the
 * expensive half of the workload the one whose oracle nobody re-runs.
 *
 * A difference here is a FINDING, not a fixture to update: it means the vendored
 * oracle stopped being the code that ran on Base, or the replay path underneath
 * it changed what it feeds a processor. `run/regenerate-golden-state.ts` is the
 * same computation with a write at the end, for the day one is deliberate.
 */
import * as fs from 'node:fs';
import {describe, expect, it} from 'vitest';
import {ALPHA1, BASE_ABANDONED, canonical, type WorkloadFixture} from '../src/fixtures.js';
import {computeWithOracle} from '../src/oracle.js';

describe.each([BASE_ABANDONED, ALPHA1])('the golden state of $name', (fixture: WorkloadFixture) => {
	it('is what the original stratagems JSProcessor computes from the committed stream', async () => {
		const recomputed = canonical(await computeWithOracle(fixture));

		expect(recomputed).toBe(fs.readFileSync(fixture.goldenStatePath, 'utf-8'));
	}, 120_000);
});
