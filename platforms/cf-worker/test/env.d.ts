/**
 * What `cloudflare:test`'s `env` actually holds in THESE tests.
 *
 * `Cloudflare.Env` ships EMPTY from `@cloudflare/workers-types` and is meant to
 * be merged into per project (`wrangler types` generates exactly this kind of
 * file). The worker's own bindings are already described by `CloudflareEnv`;
 * `TEST_MIGRATIONS` is bound by `vitest.config.ts` through miniflare and exists
 * only under test, which is why this declaration lives in `test/` rather than
 * beside the worker.
 */
import type {D1Migration} from 'cloudflare:test';
import type {CloudflareEnv} from '../src/env.js';

declare global {
	namespace Cloudflare {
		interface Env extends CloudflareEnv {
			TEST_MIGRATIONS: D1Migration[];
		}
	}
}
