import * as fs from 'node:fs';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {expect, test} from '@playwright/test';
import {mountHarness} from 'playwright-browser-harness';

/**
 * Four tabs, one database, all of them writing.
 *
 * This is a load-bearing part of why IndexedDB is the browser default rather
 * than wasm SQLite, and it is observed rather than quoted. In
 * `work/notes/findings/sqlite-in-the-browser.md`, three of four tabs FAILED AT
 * OPEN on both SQLite VFSs (`createSyncAccessHandle` on `opfs-sahpool`,
 * `SQLITE_BUSY` on `opfs`), while IndexedDB ran four of four with zero
 * mismatches. A single-tab app is a constraint an app either has or does not,
 * and most do not: a user with the app open twice is not an exotic deployment.
 *
 * Each tab owns its own block heights (a block is applied once, by definition),
 * writes its own rows, reads them back, and a fifth connection afterwards audits
 * that every tab's rows are in the one database.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(HERE, '../../../docs/spikes/indexeddb-row-backend-browser-default/results');
const CUT = path.join(HERE, 'cut.ts');
const TABS = 4;
const BLOCKS = 20;

/** What one tab reported: what it wrote, what it read back, or why it could not. */
type TabOutcome = {tab: number; errors: string[]; wrote?: number; readBack?: number; mismatches?: number};

test('four tabs against one database complete with zero row mismatches', async ({browser}, testInfo) => {
	const tag = `multitab-${Date.now()}`;
	const context = await browser.newContext();
	const first = await context.newPage();
	const lead = await mountHarness(first, {cut: CUT, coi: false});
	const tabs = [lead];

	try {
		for (let index = 1; index < TABS; index++) {
			const page = await context.newPage();
			// the same bundle and the same server: four tabs of ONE app
			tabs.push(
				await mountHarness(page, {cut: CUT, coi: false, prebuilt: {outdir: lead.outdir, serverUrl: lead.serverUrl}}),
			);
		}

		const outcomes: TabOutcome[] = await Promise.all(
			tabs.map((harness, tab) =>
				harness
					.run({phase: 'once', params: {case: 'multi-tab', tag, tab, tabs: TABS, blocks: BLOCKS}})
					.then((run) => ({tab, errors: run.errors, ...run.results}) as TabOutcome)
					// a tab that cannot even OPEN the database is the failure mode this
					// case exists to look for, so it is recorded rather than thrown
					.catch((error) => ({tab, errors: [`${(error as Error).message}`]}) as TabOutcome),
			),
		);

		const audit = await lead.run({phase: 'once', params: {case: 'multi-tab-audit', tag, tabs: TABS, blocks: BLOCKS}});

		fs.mkdirSync(RESULTS, {recursive: true});
		fs.writeFileSync(
			path.join(RESULTS, `multi-tab-${testInfo.project.name}.json`),
			JSON.stringify(
				{project: testInfo.project.name, ranAt: new Date().toISOString(), tabs: outcomes, audit: audit.results},
				null,
				2,
			),
		);

		expect(outcomes.filter((outcome) => (outcome.errors ?? []).length > 0)).toEqual([]);
		for (const outcome of outcomes) {
			expect(outcome.readBack).toBe(BLOCKS);
			expect(outcome.mismatches).toBe(0);
		}
		expect(audit.errors).toEqual([]);
		expect(audit.results.missing).toBe(0);
		expect(audit.results.found).toBe(TABS * BLOCKS);
	} finally {
		for (const harness of tabs) await harness.dispose().catch(() => undefined);
		await context.close();
	}
});
