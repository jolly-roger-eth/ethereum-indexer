import {defineConfig, devices} from '@playwright/test';

/**
 * Three engines, because the browser this ships in is not a choice we make.
 * The mid-range device profile is a separate project rather than a flag: it is
 * Chromium with CPU throttling applied over CDP (see `browser/storage.spec.ts`),
 * which is emulation, and calling it by its own name keeps it from being read
 * as a measurement of real hardware.
 */
export default defineConfig({
	testDir: './browser',
	timeout: 15 * 60 * 1000,
	expect: {timeout: 30 * 1000},
	fullyParallel: false,
	workers: 1,
	reporter: [['list'], ['json', {outputFile: 'results/playwright.json'}]],
	projects: [
		{name: 'chromium', use: {...devices['Desktop Chrome']}},
		{name: 'firefox', use: {...devices['Desktop Firefox']}},
		{name: 'webkit', use: {...devices['Desktop Safari']}},
	],
});
