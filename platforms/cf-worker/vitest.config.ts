import path from 'node:path';
import {defineConfig} from 'vitest/config';
import {cloudflareTest, readD1Migrations} from '@cloudflare/vitest-pool-workers';

// NOTE on the API shape: `@cloudflare/vitest-pool-workers` v0.22 (the first line
// that supports vitest 4, which this repo is on) REMOVED the `./config` entry
// point and its `defineWorkersConfig` helper. The pool is now a Vite plugin,
// `cloudflareTest(...)`. The house template still uses the old form because it
// is pinned to an older vitest; do not "fix" this file back to match it.
export default defineConfig({
	plugins: [
		cloudflareTest(async () => {
			// The worker is tested against the SAME fixed-table SQL the server package
			// ships, not a copy: a schema that drifted between host and server would
			// otherwise pass here and fail in production.
			const migrations = await readD1Migrations(path.join(__dirname, '../../packages/server/src/schema/sql'));
			return {
				wrangler: {configPath: './wrangler.toml', environment: 'production'},
				miniflare: {bindings: {TEST_MIGRATIONS: migrations}},
			};
		}),
	],
	test: {
		// Vitest defaults to 5s. That is fine on an idle box and wrong on a machine
		// someone is using: the gate runs the whole workspace at once, so a heavy
		// suite competes with everything else and a normally-fast test blows the
		// limit. It reddened the gate three times in one session, in three
		// unrelated packages, each time blocking a task that had nothing to do
		// with the test that failed. A generous timeout costs nothing when tests
		// pass, since it is only reached on failure. See ADR-0032.
		testTimeout: 60_000,
		hookTimeout: 60_000,
		setupFiles: ['./test/vitest/apply-migrations.ts'],
	},
});
