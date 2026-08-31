import {defineConfig, devices} from '@playwright/test';

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
