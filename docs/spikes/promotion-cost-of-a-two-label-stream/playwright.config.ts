import {defineConfig, devices} from '@playwright/test';

/**
 * Three engines, because the browser this ships in is not a choice we make, and
 * IndexedDB's structured-clone cost is an implementation detail of each one.
 */
export default defineConfig({
	testDir: './browser',
	timeout: 10 * 60 * 1000,
	expect: {timeout: 60 * 1000},
	fullyParallel: false,
	workers: 1,
	reporter: [['list']],
	projects: [
		{name: 'chromium', use: {...devices['Desktop Chrome']}},
		{name: 'firefox', use: {...devices['Desktop Firefox']}},
		{name: 'webkit', use: {...devices['Desktop Safari']}},
	],
});
