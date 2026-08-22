import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {isBuiltin} from 'node:module';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';

/**
 * Every package a published `.d.ts` imports from must be a real dependency.
 *
 * A type-only import is erased from the emitted `.js` but SURVIVES in the
 * emitted `.d.ts`, so a package whose public types name `abitype` or `eip-1193`
 * needs those resolvable by the consumer, not merely by us at build time. Put
 * them in `devDependencies` and the published package is broken for anyone who
 * installs it.
 *
 * The reason this needs a test rather than a review habit is that the failure is
 * usually INVISIBLE here. pnpm keeps a hoisted fallback directory
 * (`node_modules/.pnpm/node_modules/`) holding every transitive package, so an
 * undeclared import resolves anyway as long as something else in the tree
 * happens to depend on it. `abitype` sat undeclared for exactly that reason,
 * pulled in by viem; it broke only under `hoist=false`, while `eip-1193`, which
 * nothing else depends on, broke everywhere. Two instances of one bug, one of
 * them masked, and neither visible from inside the workspace.
 *
 * This lives in the core package's suite because there is no workspace-level
 * test harness, and it deliberately checks EVERY package: the failure message
 * names the offending one.
 */

const PACKAGES = new URL('../../', import.meta.url).pathname;

/** `@scope/name/sub` -> `@scope/name`; `name/sub` -> `name`. */
function packageOf(specifier: string): string {
	const parts = specifier.split('/');
	return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function declarationFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return declarationFiles(path);
		return entry.name.endsWith('.d.ts') || entry.name.endsWith('.d.cts') ? [path] : [];
	});
}

/** Bare specifiers a declaration file imports or re-exports, including `import('x')` types. */
function importedPackages(source: string): Set<string> {
	const found = new Set<string>();
	for (const pattern of [/(?:from|import)\s*\(?\s*'([^']+)'/g, /(?:from|import)\s*\(?\s*"([^"]+)"/g]) {
		for (const match of source.matchAll(pattern)) {
			const specifier = match[1];
			if (specifier.startsWith('.') || isBuiltin(specifier)) continue;
			found.add(packageOf(specifier));
		}
	}
	return found;
}

const workspacePackages = readdirSync(PACKAGES, {withFileTypes: true})
	.filter((entry) => entry.isDirectory() && existsSync(join(PACKAGES, entry.name, 'package.json')))
	.map((entry) => entry.name);

describe('published .d.ts files only import declared dependencies', () => {
	it('finds the workspace packages', () => {
		expect(workspacePackages.length).toBeGreaterThan(0);
	});

	for (const name of workspacePackages) {
		const dist = join(PACKAGES, name, 'dist');
		const files = declarationFiles(dist);
		// A package with no build output yet has nothing to say; `pnpm build` runs
		// on install, so in practice these are populated.
		const runner = files.length > 0 ? it : it.skip;

		runner(`${name}`, () => {
			const manifest = JSON.parse(readFileSync(join(PACKAGES, name, 'package.json'), 'utf-8'));
			const declared = new Set([
				...Object.keys(manifest.dependencies ?? {}),
				...Object.keys(manifest.peerDependencies ?? {}),
			]);

			const offenders: string[] = [];
			for (const file of files) {
				for (const imported of importedPackages(readFileSync(file, 'utf-8'))) {
					if (imported === manifest.name || declared.has(imported)) continue;
					const where = Object.keys(manifest.devDependencies ?? {}).includes(imported)
						? 'is a devDependency'
						: 'is not declared at all';
					offenders.push(`${file.slice(PACKAGES.length)} imports '${imported}', which ${where}`);
				}
			}

			expect(
				offenders,
				`${manifest.name}'s published types import packages a consumer will not have:\n  ${offenders.join('\n  ')}`,
			).toEqual([]);
		});
	}
});
