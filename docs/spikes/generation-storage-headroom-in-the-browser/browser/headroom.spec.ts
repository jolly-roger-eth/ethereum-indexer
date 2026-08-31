/**
 * Two runs, and the second is the one with teeth.
 *
 *   FOOTPRINT   all three engines, real quota, a few generations of the real
 *               history: what does a generation cost, and does
 *               `navigator.storage.estimate()` track it?
 *
 *   QUOTA-TEAR  chromium only, quota forced down over CDP
 *               (`Storage.overrideQuotaForOrigin`) so the write fails
 *               DETERMINISTICALLY partway. Chromium-only because it is the only
 *               engine that can be told to have a small quota; filling a real
 *               disk to find out is not a test, it is an outage.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {test, expect} from '@playwright/test';
import {mountHarness} from 'playwright-browser-harness';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(HERE, '../results');
const CUT = path.join(HERE, 'cut.ts');
const FIXTURE = path.join(
	HERE,
	'../../../../packages/conformance-workload-stratagems/fixtures/stratagems-alpha1.stream.json.gz',
);

const REPEAT = Number(process.env.SPIKE_REPEAT ?? 1);
const rows: Record<string, unknown>[] = [];

test.afterAll(async ({}, testInfo) => {
	fs.mkdirSync(RESULTS, {recursive: true});
	const file = path.join(RESULTS, `headroom-${testInfo.project.name}.json`);
	const existing = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf-8')).rows ?? []) : [];
	const keyOf = (r: any) => `${r.mode}|${r.repeat}`;
	const merged = new Map<string, unknown>();
	for (const r of existing) merged.set(keyOf(r), r);
	for (const r of rows) merged.set(keyOf(r), r);
	fs.writeFileSync(
		file,
		JSON.stringify({project: testInfo.project.name, ranAt: new Date().toISOString(), rows: [...merged.values()]}, null, 2),
	);
});

test(`footprint @ ${REPEAT}x`, async ({page}, testInfo) => {
	const harness = await mountHarness(page, {cut: CUT, coi: false, assets: [FIXTURE]});
	try {
		const run = await harness.run({
			phase: 'once',
			params: {mode: 'footprint', repeat: REPEAT, sealAfter: 1000, maxGenerations: 3, tag: `fp${Date.now()}`},
		});
		rows.push({project: testInfo.project.name, mode: 'footprint', repeat: REPEAT, ...run.results, env: run.env});
		expect(run.errors).toEqual([]);
	} finally {
		await harness.dispose();
	}
});

/**
 * Force the quota down and write until it refuses.
 *
 * The assertion is deliberately narrow: we do NOT assert that a quota failure
 * cannot happen (it can, and the design must cope), only that when it does the
 * failing `setMany` is ALL-OR-NOTHING. A torn commit would mean the storage
 * design's atomic segment-plus-cursor rule does not hold under the one failure
 * mode a browser actually produces, which is a spec-level defect and not a
 * tuning problem.
 */
test('quota-tear (chromium only, quota forced via CDP)', async ({page, browserName}, testInfo) => {
	test.skip(browserName !== 'chromium', 'only chromium can override the origin quota');

	const client = await page.context().newCDPSession(page);
	const harness = await mountHarness(page, {cut: CUT, coi: false, assets: [FIXTURE]});
	try {
		const origin = new URL(page.url()).origin;
		// Small enough that a few segments of the real history will not fit.
		await client.send('Storage.overrideQuotaForOrigin', {origin, quotaSize: 8 * 1024 * 1024});

		const run = await harness.run({
			phase: 'once',
			params: {mode: 'quota-tear', repeat: REPEAT, sealAfter: 1000, maxGenerations: 8, tag: `qt${Date.now()}`},
		});
		rows.push({project: testInfo.project.name, mode: 'quota-tear', repeat: REPEAT, ...run.results, env: run.env});

		expect(run.errors).toEqual([]);
		const hit = (run.results as any).quotaHit;
		if (hit) {
			testInfo.annotations.push({type: 'quota', description: `${hit.errorName} at generation ${hit.generation}`});
			expect(hit.transactionTorn, 'a quota failure must not tear a setMany commit').toBe(false);
		} else {
			testInfo.annotations.push({type: 'quota', description: 'quota never reached; raise SPIKE_REPEAT'});
		}
	} finally {
		await client.send('Storage.overrideQuotaForOrigin', {origin: new URL(page.url()).origin}).catch(() => {});
		await harness.dispose();
	}
});
