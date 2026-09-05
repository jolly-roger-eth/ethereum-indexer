import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {REORG_COUNTER_KEY, REORG_LAST_KEY} from '../src/index.js';

/**
 * A CONCLUDED REORG IS WRITTEN DOWN IN EXACTLY ONE PLACE (ADR-0050).
 *
 * The defect this closes was not that the counter was wrong; it was that the
 * counter belonged to a TRANSPORT. `recordReorg` lived on the HTTP ingest route,
 * so `etherfold run` -- which folds through `createDirectIngestion` and touches
 * no route -- reported `{absence: 0, contradiction: 0}` for ever while
 * `etherfold index` folding the identical chain reported the revert it made.
 *
 * The obvious repair is the wrong one: adding a second call site for the shapes
 * that were blind. Then the shape that both CONCLUDES and RECEIVES has two, and
 * double-counts. So the rule is structural rather than careful -- the count is
 * taken once, inside `StreamBuilder.receive`, and persisted by whoever owns the
 * store -- and this is what stops a later change quietly growing the second site
 * back.
 *
 * It lives in the core package's suite for the same reason
 * `typecheckCoverage.test.ts` does: it is a fact about the WORKSPACE and there is
 * no workspace-level test harness.
 */

const ROOT = new URL('../../../', import.meta.url).pathname;

/** Where SHIPPED code lives. A test may write a Meta row to set a scenario up; shipped code may not. */
const GROUPS = ['packages', 'platforms'];

/** The DURABLE key names, however a file happens to reach them. */
const KEY_NAMES = [
	REORG_COUNTER_KEY.absence,
	REORG_COUNTER_KEY.contradiction,
	REORG_LAST_KEY,
	'REORG_COUNTER_KEY',
	'REORG_LAST_KEY',
];

function sourceFilesOf(packageDirectory: string): string[] {
	const src = join(packageDirectory, 'src');
	if (!existsSync(src)) return [];
	const found: string[] = [];
	const walk = (directory: string) => {
		for (const entry of readdirSync(directory, {withFileTypes: true})) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.name.endsWith('.ts')) found.push(path);
		}
	};
	walk(src);
	return found;
}

const shippedSources = GROUPS.flatMap((group) =>
	readdirSync(join(ROOT, group), {withFileTypes: true})
		.filter((entry) => entry.isDirectory())
		.flatMap((entry) => sourceFilesOf(join(ROOT, group, entry.name))),
);

/** A file that writes a reorg count: it names one of the keys AND writes a row under it. */
const writeSites = shippedSources
	.map((path) => ({path, text: readFileSync(path, 'utf-8')}))
	.filter(({text}) => KEY_NAMES.some((key) => text.includes(key)))
	.filter(({text}) => /INSERT\s+INTO|UPDATE\s+Meta|writeCursor|\.put\(/i.test(text))
	.map(({path}) => path.slice(ROOT.length));

describe('a concluded reorg has ONE writer', () => {
	it('finds the shipped sources to scan at all', () => {
		expect(shippedSources.length).toBeGreaterThan(50);
	});

	it('is written in exactly one module, the one the store owner builds its recorder from', () => {
		expect(writeSites).toEqual(['packages/cli/src/reorgCounters.ts']);
	});

	it('is not written by the HTTP server, which is a CALLER of the fold and not its owner', () => {
		// the specific regression: `@etherfold/server` owned this write, and the
		// deployment shape the milestone calls the default never reaches it
		expect(writeSites.filter((path) => path.startsWith('packages/server/'))).toEqual([]);
	});

	it('is not taken by anything that merely RECEIVES an outcome', () => {
		// `IngestionOutcome.reorg` is reported so a caller can log it, answer a sender
		// or decide what to do next. A caller that counted from it would count only on
		// the shape it happens to be, and twice on the shape that is both.
		const callers = ['packages/server/src/api/ingest.ts', 'packages/core/src/directIngestion.ts'];
		for (const caller of callers) {
			expect(readFileSync(join(ROOT, caller), 'utf-8')).not.toMatch(/INSERT\s+INTO\s+Meta/i);
		}
	});
});
