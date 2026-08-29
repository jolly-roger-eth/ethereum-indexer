import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {isBuiltin} from 'node:module';
import {join} from 'node:path';
import ts from 'typescript';
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
 *
 * A NOTE ON WHAT IT READS. This inspects `dist/`, which it does not build, so it
 * is only as truthful as that directory. It was green for months against
 * `dist/index.d.cts` files dated months before the sources beside them: leftovers
 * from a build setup this repo no longer uses, which no current script emits.
 * Every emitting package now cleans `dist` before building, so orphans cannot
 * survive a build, and the two cases below make the remaining ways of lying
 * loud: a package that should have declarations but has none is a FAILURE rather
 * than a silent skip, and any artifact the build could not have produced is a
 * failure naming the stale file.
 *
 * A NOTE ON HOW IT READS IT. It PARSES. This was a text search once, and a text
 * search cannot tell a declaration from a sentence that mentions one: a doc
 * comment was read as a dependency and reddened the gate over prose. See the
 * second `describe` below, which is the reading rule.
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

/** Everything under `dir`, used to spot artifacts no current build step emits. */
function allFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
		const path = join(dir, entry.name);
		return entry.isDirectory() ? allFiles(path) : [path];
	});
}

/**
 * Bare specifiers a declaration file imports or re-exports, including
 * `import('x')` types, read out of the PARSE rather than out of the text.
 *
 * The four syntactic forms below are the whole of how a `.d.ts` can name another
 * module, and each one is a node the parser hands us as a module specifier: a
 * position no comment and no string literal can occupy. That is the entire point
 * of parsing here. TypeScript is already a devDependency of this package, so the
 * honest reading costs nothing beyond one `createSourceFile` per file.
 *
 * `declare module 'x' {}` is deliberately NOT counted: it augments or shims a
 * module rather than importing one, and whatever really pulls that module in is
 * an import this already reports. Nor is a triple-slash
 * `/// <reference types="x" />`, which the text search never caught either;
 * widening what the gate catches is a separate decision from fixing how it
 * reads.
 */
function importedPackages(source: string): Set<string> {
	const found = new Set<string>();
	// The name matters: it is what makes TypeScript parse this as a declaration
	// file. `setParentNodes` stays off because nothing here walks upwards.
	const parsed = ts.createSourceFile('scanned.d.ts', source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);

	function record(node: ts.Node | undefined): void {
		if (!node || !ts.isStringLiteralLike(node)) return;
		const specifier = node.text;
		if (specifier.startsWith('.') || isBuiltin(specifier)) return;
		found.add(packageOf(specifier));
	}

	function visit(node: ts.Node): void {
		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
			// `import ... from 'x'`, `export ... from 'x'`, `export * from 'x'`.
			record(node.moduleSpecifier);
		} else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
			// `import('x').Type`, the form an inferred return type is emitted as, and
			// the one most likely to name a package the author never typed.
			record(node.argument.literal);
		} else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
			// `import x = require('x')`.
			record(node.moduleReference.expression);
		} else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
			// `import('x')` as an expression, should one ever reach a declaration file.
			record(node.arguments[0]);
		}
		ts.forEachChild(node, visit);
	}

	ts.forEachChild(parsed, visit);
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
		const manifestPath = join(PACKAGES, name, 'package.json');
		const pkg = JSON.parse(readFileSync(manifestPath, 'utf-8'));
		// A package that publishes types out of `dist` MUST have them after a build.
		// Skipping when the directory is empty is how a package that silently stopped
		// building would go unnoticed here.
		const publishesTypes = typeof pkg.types === 'string' && pkg.types.includes('dist');

		if (publishesTypes) {
			it(`${name} has the declarations it claims to publish`, () => {
				expect(
					declarationFiles(dist).length,
					`${pkg.name} declares "types": "${pkg.types}" but dist/ has no declaration files. Run \`pnpm build\`.`,
				).toBeGreaterThan(0);
			});

			it(`${name} has no build artifact its build cannot emit`, () => {
				// Every build here is plain `tsc` on an ESM package, so it emits .js and
				// .d.ts (plus maps). A .cts/.mts/.cjs/.mjs in dist is therefore an orphan
				// of an older toolchain, which is exactly what made this suite lie before.
				const orphans = allFiles(dist).filter((f) => /\.(c|m)(js|ts)$/.test(f) || /\.d\.(c|m)ts$/.test(f));
				expect(
					orphans.map((f) => f.slice(PACKAGES.length)),
					`${pkg.name} has stale build output that no current build step produces. Remove dist/ and rebuild.`,
				).toEqual([]);
			});
		}

		const files = declarationFiles(dist);
		const runner = files.length > 0 ? it : it.skip;

		runner(`${name}`, () => {
			const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
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

/**
 * What the scan above COUNTS as an import, pinned directly.
 *
 * This used to be a text search, and a text search cannot tell a declaration
 * from a sentence that mentions one. A doc comment reading `nothing
 * distinguished "the chain had none" from "we never asked"` was reported as
 * `core/dist/types.d.ts imports 'we never asked', which is not declared at all`,
 * and the gate went red on a COMMENT. The author reworded the prose to get past
 * it, which is the expensive lesson: it teaches people to change what a comment
 * SAYS to satisfy a test that was never about comments, in a repository whose
 * whole documentation style is long explanatory comments.
 *
 * So the cases below are the reading rule, not incidental examples. The first is
 * the exact shape that broke it.
 */
describe('the scan reads declarations, not prose', () => {
	it('ignores an import specifier written in JSDoc prose', () => {
		const declaration = `
/**
 * A spliced event's logs were never asked for, and afterwards nothing
 * distinguished "the chain had none" from "we never asked".
 */
export type Spliced = {topic0: string};
`;
		expect([...importedPackages(declaration)]).toEqual([]);
	});

	it('ignores an import written out inside an @example block', () => {
		const declaration = `
/**
 * @example
 * import {createIndexer} from 'left-pad';
 * const indexer = createIndexer();
 */
export declare function createIndexer(): void;
`;
		expect([...importedPackages(declaration)]).toEqual([]);
	});

	it('ignores an import mentioned in a line comment', () => {
		expect([...importedPackages(`// as in \`import x from 'left-pad'\`\nexport declare const x: number;\n`)]).toEqual(
			[],
		);
	});

	it('finds every form a declaration file really imports through', () => {
		const declaration = `
import type {Abi} from 'abitype';
import {createClient} from 'viem/clients/createClient';
export * from 'eip-1193';
export type Logger = import('named-logs').Logger;
export declare const later: () => Promise<typeof import('immer')>;
`;
		expect([...importedPackages(declaration)].sort()).toEqual(['abitype', 'eip-1193', 'immer', 'named-logs', 'viem']);
	});

	it('still ignores relative specifiers and node built-ins', () => {
		const declaration = `
import type {Local} from './local.js';
import type {Buffer} from 'node:buffer';
export type Held = {local: Local; buffer: Buffer};
`;
		expect([...importedPackages(declaration)]).toEqual([]);
	});

	it('does not count an import specifier that is merely the text of a string literal', () => {
		// A string literal type is DATA, not a module reference: nothing resolves it,
		// so a consumer missing that package is not broken by it. The old text search
		// reported it; a parse cannot, and should not.
		expect([...importedPackages(`export type Hint = "run: import x from 'left-pad'";\n`)]).toEqual([]);
	});

	it('reads the real emitted declarations rather than parsing them into nothing', () => {
		// The failure mode of a parser-based scan is the silent one: a parse that
		// yields no imports makes every package look clean. This package's public
		// types are built out of `abitype` and `viem`, so an empty answer here means
		// the scan stopped reading, not that the imports went away.
		const found = new Set<string>();
		for (const file of declarationFiles(join(PACKAGES, 'core', 'dist'))) {
			for (const imported of importedPackages(readFileSync(file, 'utf-8'))) found.add(imported);
		}
		expect(
			[...found],
			'@etherfold/core\u2019s emitted declarations import nothing at all, which cannot be true',
		).not.toEqual([]);
	});
});
