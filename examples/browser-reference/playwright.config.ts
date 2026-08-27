import {defineConfig, devices} from '@playwright/test';

/**
 * `pnpm --filter browser-reference verify:browser`.
 *
 * Deliberately NOT in the acceptance gate (ADR-0030): it needs a browser binary
 * a clean checkout does not have. It needs NOTHING ELSE, though -- no live RPC,
 * no wallet extension, no funded account. The wallet and the chain are both
 * injected into the page, so the reference's real wiring runs against a
 * deterministic chain and every claim in it is checkable by anyone, offline.
 */
export default defineConfig({
	testDir: './verify',
	timeout: 2 * 60 * 1000,
	// Generous, because the server is never reused (below), so the first page load
	// of a run pays for a cold Vite dependency optimisation. A short assertion
	// timeout here does not catch a slow app, it catches a cold bundler.
	expect: {timeout: 30 * 1000},
	fullyParallel: false,
	workers: 1,
	reporter: [['list']],
	webServer: {
		command: 'npx vite --port 5599 --strictPort',
		url: 'http://localhost:5599',
		// NEVER reuse, even locally. Vite caches its transform of each module, so a
		// server left running from a previous invocation serves the PREVIOUS source
		// after an edit -- which was observed here, as a run that stayed red for a
		// change that had already been reverted. A verification that can report on
		// code that is no longer on disk is worse than no verification.
		reuseExistingServer: false,
		timeout: 60 * 1000,
	},
	use: {baseURL: 'http://localhost:5599'},
	projects: [{name: 'chromium', use: {...devices['Desktop Chrome']}}],
});
