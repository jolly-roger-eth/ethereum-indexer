import {expect, test, type Page} from '@playwright/test';
import {mountHarness} from 'playwright-browser-harness';
import {EXPECTED_A, EXPECTED_B, START_BLOCK} from './workload.js';

/**
 * A browser tab indexing with an entity processor, on the engines it has to work
 * on.
 *
 * The node tests ask the same questions of the same workload under
 * `fake-indexeddb`. What a shim cannot show is exactly what this path is for:
 * a real transaction scheduler, a real database that outlives a page, and a real
 * RELOAD, which is the browser-specific risk in the whole feature (a tab that
 * indexes, closes and reopens must CONTINUE, not start again).
 *
 * Deliberately not part of `pnpm test`, which is what the acceptance gate runs:
 * this needs `playwright install` and three browser binaries a clean CI checkout
 * does not have, and a gate that cannot run on a clean checkout is a gate that
 * gets skipped.
 */

/** The bundled code-under-test. IndexedDB needs no cross-origin isolation. */
const CUT = new URL('./cut.ts', import.meta.url).pathname;

async function harnessFor(page: Page) {
	return mountHarness(page, {cut: CUT, coi: false});
}

/** Unique per run, so an engine's leftover database from a previous run is never read. */
function tag(name: string): string {
	return `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

test('indexes the captured stream through the hook, and lands on the expected state', async ({page}) => {
	const harness = await harnessFor(page);
	try {
		const run = await harness.run({phase: 'once', params: {case: 'index', tag: tag('index')}});

		expect(run.errors).toEqual([]);
		expect(run.results.state).toEqual(EXPECTED_A);
		expect(run.results.lastToBlock).toBe(run.results.latestBlock);
	} finally {
		await harness.dispose();
	}
});

test('reverts a reorg through the browser path, and the counter decreases', async ({page}) => {
	const harness = await harnessFor(page);
	try {
		const run = await harness.run({phase: 'once', params: {case: 'reorg', tag: tag('reorg')}});

		expect(run.errors).toEqual([]);
		expect(run.results.before).toEqual(EXPECTED_A);
		expect(run.results.after).toEqual(EXPECTED_B);
		expect(EXPECTED_B.transfers).toBeLessThan(EXPECTED_A.transfers);
	} finally {
		await harness.dispose();
	}
});

test('runs the same processor on whichever backend the application chose', async ({page}) => {
	const harness = await harnessFor(page);
	try {
		const run = await harness.run({phase: 'once', params: {case: 'backends', tag: tag('backends')}});

		expect(run.errors).toEqual([]);
		expect(run.results.indexeddb).toEqual(EXPECTED_A);
		// the claim, in the form that matters: three stores that were never told
		// about each other, one processor, one answer.
		expect(run.results.patch).toEqual(run.results.indexeddb);
		expect(run.results.memory).toEqual(run.results.indexeddb);
		// and the light one says up front what a reload will cost (ADR-0023)
		expect(run.results.patchDurability).toBe('memory-only');
	} finally {
		await harness.dispose();
	}
});

test('resumes from its cursor after a real page reload, instead of re-indexing', async ({page}) => {
	const harness = await harnessFor(page);
	const params = {tag: tag('reload')};
	try {
		const first = await harness.run({phase: 'write', params});
		expect(first.errors).toEqual([]);
		expect(first.results.state).toEqual(EXPECTED_A);
		// the first tab did start at the beginning, which is what makes the second
		// tab's answer meaningful
		expect(first.results.firstRangeFrom).toBe(START_BLOCK);

		await harness.reload();

		const second = await harness.run({phase: 'read', params});
		expect(second.errors).toEqual([]);
		expect(second.results.state).toEqual(EXPECTED_A);
		// nothing of the first page survived except IndexedDB, and IndexedDB held
		// the cursor: the reopened tab picked up inside the unconfirmed window it
		// had recorded rather than at the start block.
		expect(second.results.firstRangeFrom).toBeGreaterThan(START_BLOCK);
	} finally {
		await harness.dispose();
	}
});
