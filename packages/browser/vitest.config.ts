import {defineConfig} from 'vitest/config';

/**
 * Vitest runs the node-side tests only.
 *
 * `browser/` holds the shared workload and the Playwright specs that drive it in
 * a real engine (`pnpm test:browser`). Their `.spec.ts` names would otherwise be
 * collected here and fail on `@playwright/test`'s `test` export.
 */
export default defineConfig({
	test: {include: ['test/**/*.test.ts']},
});
