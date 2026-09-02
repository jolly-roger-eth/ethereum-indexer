import {build} from 'esbuild';
import {describe, expect, it} from 'vitest';

/**
 * This package must BUNDLE for a browser, which is not the same claim as "it
 * compiles".
 *
 * `tsc` resolves `node:path` happily and vitest runs in node, so a runtime
 * built-in reaching this package from a transitive dependency is invisible to
 * every other check here -- and fatal at the only place it matters, which is an
 * application's bundler. That is exactly what happened: `@etherfold/utils`'
 * barrel re-exports the CLI's processor loader (`node:module`, `node:path`) and
 * the deployment reader (`node:fs`), so `import '@etherfold/browser'` could not
 * be built for a browser at all, by esbuild or by vite. That dependency is gone
 * entirely now (it was there for the published blob snapshot's file naming, which
 * went with the free-form path, ADR-0037); this is what stops the class of
 * failure coming back through any other one.
 *
 * `platform: 'browser'` with no `external` is the whole assertion: esbuild
 * refuses to resolve a node built-in in that mode, so a leak is a failed build
 * naming the specifier and the file it came from.
 */
describe('@etherfold/browser', () => {
	it('bundles for a browser with no runtime built-ins', async () => {
		const result = await build({
			entryPoints: [new URL('../src/index.ts', import.meta.url).pathname],
			bundle: true,
			platform: 'browser',
			format: 'esm',
			// not written anywhere: the question is whether it RESOLVES, and the bytes
			// are of no interest.
			write: false,
			logLevel: 'silent',
		});

		expect(result.errors).toEqual([]);
	});
});
