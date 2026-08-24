/**
 * The measurement itself, in real browsers.
 *
 *   npx playwright test                          all three engines
 *   npx playwright test --project=chromium
 *   SPIKE_SIZES=tiny,small npx playwright test   a quicker pass
 *
 * Every number this writes lands in `results/browser-<project>.json`, which is
 * the raw evidence `work/notes/findings/sqlite-in-the-browser.md` cites. The
 * assertions here are deliberately weak (no errors, right answers): this is a
 * measurement, and a spike that fails its own build because a laptop was busy
 * would teach nobody anything.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {test, expect, type Page} from '@playwright/test';
import {mountHarness} from 'playwright-browser-harness';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(HERE, '../results');
const CUT = path.join(HERE, 'cut.ts');
const WORKER = path.join(HERE, 'sqlite.worker.ts');
const SQLITE_DIST = path.join(HERE, '../node_modules/@sqlite.org/sqlite-wasm/dist');

const SIZES = (process.env.SPIKE_SIZES ?? 'real,tiny,small,medium,large').split(',');
/** The captured stream, served next to the bundle so a `real` run can replay it in-page. */
const FIXTURE_ASSETS = [
	path.join(HERE, '../../../../packages/conformance-workload-stratagems/fixtures/stratagems-alpha1.stream.json.gz'),
	path.join(HERE, '../../../../packages/conformance-workload-stratagems/fixtures/stratagems-alpha1.state.json'),
];
const IDB_BACKENDS = ['memory', 'idb-versioned', 'idb-versioned-cached', 'blob-structured-clone', 'blob-json'];
const SQLITE_BACKENDS = ['sqlite-opfs', 'sqlite-opfs-sahpool'];

type Row = Record<string, unknown>;
const collected: Row[] = [];

function record(row: Row): void {
	collected.push(row);
}

test.afterAll(async ({}, testInfo) => {
	fs.mkdirSync(RESULTS, {recursive: true});
	const file = path.join(RESULTS, `browser-${testInfo.project.name}.json`);
	const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : {runs: []};
	fs.writeFileSync(
		file,
		JSON.stringify(
			{
				project: testInfo.project.name,
				ranAt: new Date().toISOString(),
				runs: [...(existing.runs ?? []).filter((run: Row) => run.ranAt === undefined), ...collected],
			},
			null,
			2,
		),
	);
});

/**
 * A mid-range phone, approximated by slowing the CPU down.
 *
 * This is EMULATION and only Chromium can do it, so it is reported under its own
 * name and never merged with the laptop numbers. It models the axis that
 * actually separates a laptop from a mid-range Android (single-core speed), and
 * not the ones that also matter (slower flash, less memory, thermal throttling),
 * so it is a floor on the gap rather than a measurement of it.
 */
async function throttle(page: Page, rate: number): Promise<void> {
	const client = await page.context().newCDPSession(page);
	await client.send('Emulation.setCPUThrottlingRate', {rate});
}

async function measure(
	page: Page,
	options: {backend: string; size: string; coi: boolean; worker: boolean; label: string; project: string},
): Promise<Row> {
	const tag = `${options.label}-${options.backend}-${options.size}-${Date.now()}`;
	const harness = await mountHarness(page, {
		cut: CUT,
		coi: options.coi,
		assets: [
			...(options.size === 'real' ? FIXTURE_ASSETS : []),
			...(options.worker ? [path.join(SQLITE_DIST, 'sqlite3-opfs-async-proxy.js')] : []),
		],
		...(options.worker ? {worker: WORKER, wasmDirs: [SQLITE_DIST]} : {}),
	});
	try {
		const env = await harness.env();
		const written = await harness.run({
			phase: 'write',
			params: {backend: options.backend, size: options.size, tag},
		});
		// A reload is the only honest cold start: it is what a user does.
		await harness.reload();
		const read = await harness.run({
			phase: 'read',
			params: {backend: options.backend, size: options.size, tag},
		});
		return {
			project: options.project,
			profile: options.label,
			backend: options.backend,
			size: options.size,
			env,
			write: {results: written.results, timings: written.timings, errors: written.errors},
			reopen: {results: read.results, timings: read.timings, errors: read.errors},
		};
	} finally {
		await harness.dispose();
	}
}

for (const size of SIZES) {
	for (const backend of IDB_BACKENDS) {
		test(`${backend} @ ${size}`, async ({page}, testInfo) => {
			const row = await measure(page, {
				backend,
				size,
				coi: false, // IndexedDB needs no cross-origin isolation, and saying so is part of the result
				worker: false,
				label: 'laptop',
				project: testInfo.project.name,
			});
			record(row);
			expect((row.write as any).errors).toEqual([]);
			expect((row.write as any).results.spotCheckMismatches).toBe(0);
		});
	}

	for (const backend of SQLITE_BACKENDS) {
		test(`${backend} @ ${size}`, async ({page}, testInfo) => {
			const row = await measure(page, {
				backend,
				size,
				// `opfs` needs cross-origin isolation; `opfs-sahpool` exists precisely
				// so it does not. Running each under the headers it actually requires
				// is the comparison, not a detail.
				coi: backend === 'sqlite-opfs',
				worker: true,
				label: 'laptop',
				project: testInfo.project.name,
			});
			record(row);
			// A SQLite candidate that cannot start is a RESULT, not a broken test:
			// WebKit under Playwright has no OPFS, so `opfs-sahpool` fails with
			// "Missing required OPFS APIs" and `opfs` silently degrades to memory.
			// Recording that is the job; failing the run would only hide it.
			const errors = (row.write as any).errors as string[];
			if (errors.length > 0) {
				testInfo.annotations.push({type: 'backend-unavailable', description: errors[0]});
			} else {
				expect((row.write as any).results.spotCheckMismatches).toBe(0);
			}
		});
	}
}

/** The same sweep, on a slow CPU. Chromium only: nothing else can emulate one. */
test.describe('mid-range device profile (4x CPU throttle)', () => {
	test.skip(({browserName}) => browserName !== 'chromium', 'CPU throttling is a CDP feature');

	for (const backend of ['idb-versioned', 'blob-structured-clone', 'sqlite-opfs-sahpool']) {
		test(`${backend} @ medium, throttled`, async ({page}, testInfo) => {
			await throttle(page, 4);
			const row = await measure(page, {
				backend,
				size: 'medium',
				coi: false,
				worker: backend.startsWith('sqlite'),
				label: 'mid-range-4x',
				project: testInfo.project.name,
			});
			record(row);
			expect((row.write as any).errors).toEqual([]);
		});
	}
});

/**
 * The captured Base stream, replayed in a real browser.
 *
 * The generated workloads above are what the SIZES are made of; this is the
 * REAL one. It is small (42 events in 9 blocks), so it proves nothing about
 * performance and everything about the fixture: that a browser can load it, and
 * that replaying it there lands on the same state node computed.
 */
test('the captured Base stream replays in the browser to the same state', async ({page}, testInfo) => {
	const harness = await mountHarness(page, {cut: path.join(HERE, 'fixture-cut.ts'), coi: false, assets: FIXTURE_ASSETS});
	try {
		const result = await harness.run({phase: 'once', params: {}});
		record({
			project: testInfo.project.name,
			profile: 'laptop',
			backend: 'captured-fixture-replay',
			size: 'real',
			env: await harness.env(),
			write: {results: result.results, timings: result.timings, errors: result.errors},
		});
		expect(result.errors).toEqual([]);
		expect(result.results.matchesGoldenState).toBe(true);
		expect(result.results.idbMismatches).toBe(0);
	} finally {
		await harness.dispose();
	}
});

/**
 * The light path, measured where it runs.
 *
 * It is not a storage backend, so it is not in the sweep above; it is the third
 * option the spec has to choose between, and its as-of cost is the whole of the
 * spec's second open question.
 */
test('immer reverse patches: backwards replay cost and correctness', async ({page}, testInfo) => {
	const harness = await mountHarness(page, {cut: path.join(HERE, 'patch-cut.ts'), coi: false});
	try {
		const result = await harness.run({phase: 'once', params: {size: 'medium'}});
		record({
			project: testInfo.project.name,
			profile: 'laptop',
			backend: 'immer-patch-replay',
			size: 'medium',
			env: await harness.env(),
			write: {results: result.results, timings: result.timings, errors: result.errors},
		});
		expect(result.errors).toEqual([]);
		expect(result.results.allCorrect).toBe(true);
	} finally {
		await harness.dispose();
	}
});

/**
 * Multi-tab, which is where the SQLite route is known to hurt.
 *
 * Four pages against ONE origin and ONE database name, all writing. IndexedDB is
 * specified to handle this (transactions serialise); `opfs-sahpool` holds a
 * single connection by design, and `opfs` reports `SQLITE_BUSY`. What is
 * recorded is what each one DID, not what the documentation says it does.
 */
test.describe('multi-tab', () => {
	for (const backend of ['idb-versioned', 'sqlite-opfs-sahpool', 'sqlite-opfs']) {
		test(`${backend} across 4 tabs`, async ({browser}, testInfo) => {
			const coi = backend === 'sqlite-opfs';
			const worker = backend.startsWith('sqlite');
			const context = await browser.newContext();
			const first = await context.newPage();
			const lead = await mountHarness(first, {
				cut: CUT,
				coi,
				...(worker ? {worker: WORKER, wasmDirs: [SQLITE_DIST], assets: [path.join(SQLITE_DIST, 'sqlite3-opfs-async-proxy.js')]} : {}),
			});
			const tabs = [lead];
			try {
				for (let i = 1; i < 4; i++) {
					const page = await context.newPage();
					tabs.push(
						await mountHarness(page, {
							cut: CUT,
							coi,
							prebuilt: {outdir: lead.outdir, serverUrl: lead.serverUrl},
						}),
					);
				}
				// One shared database name, so they really do collide.
				const outcomes = await Promise.all(
					tabs.map((harness, index) =>
						harness
							.run({phase: 'write', params: {backend, size: 'small', tag: 'shared-multitab', reads: 20}})
							.then((result) => ({
								tab: index,
								errors: result.errors,
								blocksPerSecond: result.results.blocksPerSecond,
								mismatches: result.results.spotCheckMismatches,
							}))
							.catch((error) => ({tab: index, errors: [`${error.message}`]})),
					),
				);
				record({
					project: testInfo.project.name,
					profile: 'multi-tab',
					backend,
					size: 'small',
					tabs: outcomes,
					tabsThatFailed: outcomes.filter((outcome) => (outcome.errors ?? []).length > 0).length,
				});
			} finally {
				for (const harness of tabs) await harness.dispose().catch(() => {});
				await context.close();
			}
		});
	}
});
