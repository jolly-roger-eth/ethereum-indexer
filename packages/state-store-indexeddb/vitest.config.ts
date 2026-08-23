import {defineConfig} from 'vitest/config';

/**
 * Vitest runs the node-side tests only.
 *
 * `browser/` holds Playwright specs, which are a different runner against a real
 * engine (`pnpm test:browser`), and their `.spec.ts` names would otherwise be
 * collected here and fail on `@playwright/test`'s `test` export.
 */
export default defineConfig({
	test: {include: ['test/**/*.test.ts']},
});
