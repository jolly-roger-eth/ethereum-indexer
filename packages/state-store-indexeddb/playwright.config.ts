import {defineConfig, devices} from '@playwright/test';

/**
 * The browser run: `pnpm --filter @etherfold/state-store-indexeddb test:browser`.
 *
 * Three engines, because the browser this ships in is not a choice we make, and
 * because the decision this backend rests on is engine-specific: Chromium's
 * IndexedDB write path degrades with dataset size while Firefox's and WebKit's
 * do not, and WebKit cannot run the wasm-SQLite alternative at all (ADR-0024).
 * WebKit under Playwright is how Safari-engine evidence is reachable from Linux.
 *
 * It is deliberately NOT part of `pnpm test`, which is what the acceptance gate
 * runs: this needs `playwright install` and three browser binaries, and a gate
 * that cannot run on a clean CI checkout is a gate that gets skipped. The node
 * side runs the same conformance suite under `fake-indexeddb` on every commit;
 * this run is what says the engines agree, and its output is kept in
 * `docs/spikes/indexeddb-row-backend-browser-default/results/`.
 */
export default defineConfig({
	testDir: './browser',
	// the shared suite is ~160 cases, each of which opens a database of its own
	timeout: 5 * 60 * 1000,
	expect: {timeout: 30 * 1000},
	fullyParallel: false,
	workers: 1,
	reporter: [
		['list'],
		['json', {outputFile: '../../docs/spikes/indexeddb-row-backend-browser-default/results/playwright.json'}],
	],
	projects: [
		{name: 'chromium', use: {...devices['Desktop Chrome']}},
		{name: 'firefox', use: {...devices['Desktop Firefox']}},
		{name: 'webkit', use: {...devices['Desktop Safari']}},
	],
});
