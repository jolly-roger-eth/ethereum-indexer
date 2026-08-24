import {defineConfig} from 'vite';

/**
 * The browser demo: `pnpm --filter event-processor-nfts browser`.
 *
 * `browser/` is the app; `src/` is the processor the app runs, imported straight
 * from source so the one command needs no build step in front of it.
 *
 * The script is called `browser` rather than `dev` on purpose: everywhere else
 * in this repository `dev` means "watch the sources and rebuild the package",
 * and `pnpm -r dev` at the root relies on that.
 */
export default defineConfig({
	root: 'browser',
	base: './',
	build: {outDir: '../dist/browser', emptyOutDir: true},
});
