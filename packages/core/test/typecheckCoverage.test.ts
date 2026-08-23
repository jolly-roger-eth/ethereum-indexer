import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';

/**
 * Every workspace package is REACHED by `pnpm typecheck`, and reaches all of itself.
 *
 * The root script fans out with pnpm filters (`./packages/*`, `./platforms/*`)
 * and pnpm SKIPS a package that has no `typecheck` script rather than failing,
 * so an uncovered package is silent: nothing goes red, the gate stays green, and
 * the package's `test/` is checked by nothing at all (vitest strips types with
 * esbuild). The same silence covered `platforms/cf-worker/vitest.config.ts` for
 * as long as the include was a LIST of the directories that happened to hold
 * code, because a package-root config sits outside `src/**` and `test/**`.
 *
 * Both halves are therefore asserted rather than remembered: a package must have
 * the config and the script, and the config must include the WHOLE package. The
 * include is the load-bearing line -- with `**\/*.ts` a new root config file or a
 * new directory is covered the day it is added, and nobody has to widen a glob.
 *
 * It lives in the core package's suite because there is no workspace-level test
 * harness, the same reason `publishedTypeDependencies.test.ts` does.
 */

const ROOT = new URL('../../../', import.meta.url).pathname;

/** Exactly what the root `typecheck` script fans out over. */
const FANOUT = ['packages', 'platforms'];

const workspacePackages = FANOUT.flatMap((group) =>
	readdirSync(join(ROOT, group), {withFileTypes: true})
		.filter((entry) => entry.isDirectory() && existsSync(join(ROOT, group, entry.name, 'package.json')))
		.map((entry) => `${group}/${entry.name}`),
);

describe('pnpm typecheck reaches every package, and all of each package', () => {
	it('finds the packages the root script fans out over', () => {
		expect(workspacePackages.length).toBeGreaterThan(0);
	});

	for (const name of workspacePackages) {
		it(`${name} is typechecked`, () => {
			const manifest = JSON.parse(readFileSync(join(ROOT, name, 'package.json'), 'utf-8'));
			expect(
				manifest.scripts?.typecheck,
				`${name} has no "typecheck" script, so the root fan-out SKIPS it silently.`,
			).toContain('tsconfig.typecheck.json');

			const configPath = join(ROOT, name, 'tsconfig.typecheck.json');
			expect(existsSync(configPath), `${name} has a typecheck script but no tsconfig.typecheck.json.`).toBe(true);

			const config = JSON.parse(readFileSync(configPath, 'utf-8'));
			expect(
				config.include,
				`${name} must include the whole package, or a file added at its root (a vitest or playwright config) ` +
					`is typechecked by nothing.`,
			).toEqual(['**/*.ts']);
		});
	}
});
