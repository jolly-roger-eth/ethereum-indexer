import {defineConfig} from 'vite';

/**
 * `pnpm --filter browser-reference browser`.
 *
 * `browser/` is the app, `src/` is the processor it runs, imported straight from
 * source so hot reload sees the processor edit that axis one is about.
 */
export default defineConfig({
	root: 'browser',
	base: './',
	build: {outDir: '../dist/browser', emptyOutDir: true},
});
