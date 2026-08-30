/**
 * The IndexedDB half, in real browsers.
 *
 *   npx playwright test --project=chromium
 *   SPIKE_SIZES=1x npx playwright test --project=chromium
 *
 * Every number lands in `results/browser-<project>.json`.
 *
 * The assertions are deliberately weak (no errors, the promoted stream reads
 * back at the right length). This is a MEASUREMENT: a spike that went red
 * because a laptop was busy would teach nobody anything, which is the same
 * stance `docs/spikes/sqlite-in-the-browser` takes and the reason
 * `appending-to-the-stream-costs-the-batch` insists its own append-cost claim be
 * asserted as WORK rather than wall-clock.
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

const SIZES = (process.env.SPIKE_SIZES ?? '1x,4x').split(',');
const SEALS = (process.env.SPIKE_SEAL ?? '250,1000,4000').split(',').map(Number);
const ARMS = ['key-label', 'key-label-unbatched', 'value-label', 'value-label+pointer'];
const CASES = ['whole-stream', 'partial-graft', 'no-sharing'];

const collected: Record<string, unknown>[] = [];

/**
 * Results are MERGED by `(arm, size, seal, case)`, not overwritten.
 *
 * A sweep is routinely run at one size at a time (`SPIKE_SIZES=8x`), and an
 * overwriting write would silently drop every size not in the current run,
 * leaving the finding quoting numbers no longer in the file it cites.
 */
test.afterAll(async ({}, testInfo) => {
	fs.mkdirSync(RESULTS, {recursive: true});
	const file = path.join(RESULTS, `browser-${testInfo.project.name}.json`);
	const keyOf = (r: any) => `${r.arm}|${r.size}|${r.sealAfter}|${r.sharingCase}`;
	const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')).rows ?? [] : [];
	const merged = new Map<string, unknown>();
	for (const row of existing) merged.set(keyOf(row), row);
	for (const row of collected) merged.set(keyOf(row), row);
	fs.writeFileSync(
		file,
		JSON.stringify(
			{
				project: testInfo.project.name,
				ranAt: new Date().toISOString(),
				note: 'ms is wall-clock; the work metrics (metadataRenames, payloadsRewritten, payloadBytesMoved, storeOps) are what the finding rests on. Rows are merged across runs by (arm, size, seal, case).',
				rows: [...merged.values()],
			},
			null,
			2,
		),
	);
});

for (const size of SIZES) {
	for (const sealAfter of SEALS) {
		for (const sharingCase of CASES) {
			for (const arm of ARMS) {
				test(`${arm} @ ${size} seal=${sealAfter} ${sharingCase}`, async ({page}, testInfo) => {
					const tag = `${arm}-${size}-${sealAfter}-${sharingCase}-${Date.now()}`.replace(/[^a-z0-9-]/gi, '');
					const harness = await mountHarness(page, {cut: CUT, coi: false, assets: [FIXTURE]});
					try {
						const run = await harness.run({
							phase: 'once',
							params: {arm, size, sealAfter, sharingCase, tag},
						});
						collected.push({
							project: testInfo.project.name,
							arm,
							size,
							sealAfter,
							sharingCase,
							env: run.env,
							results: run.results,
							timings: run.timings,
							errors: run.errors,
						});
						expect(run.errors).toEqual([]);
						expect((run.results as any).readOrderCorrect).toBe(true);
					} finally {
						await harness.dispose();
					}
				});
			}
		}
	}
}
