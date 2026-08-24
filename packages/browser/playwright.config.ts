import {defineConfig, devices} from '@playwright/test';

/**
 * The browser run: `pnpm --filter @etherfold/browser test:browser`.
 *
 * Three engines, because the browser an application ships in is not a choice
 * this package makes, and because the two things being checked here are exactly
 * the things engines disagree about: IndexedDB's transaction scheduling, and
 * what survives a page reload. WebKit under Playwright is how Safari-engine
 * evidence is reachable from Linux.
 *
 * Deliberately NOT part of `pnpm test`, which is what the acceptance gate runs:
 * this needs `playwright install` and three browser binaries a clean CI checkout
 * does not have. The node side runs the same workload under `fake-indexeddb` on
 * every commit; this run is what says the engines agree.
 */
export default defineConfig({
	testDir: './browser',
	timeout: 2 * 60 * 1000,
	expect: {timeout: 30 * 1000},
	fullyParallel: false,
	workers: 1,
	reporter: [['list']],
	projects: [
		{name: 'chromium', use: {...devices['Desktop Chrome']}},
		{name: 'firefox', use: {...devices['Desktop Firefox']}},
		{name: 'webkit', use: {...devices['Desktop Safari']}},
	],
});
