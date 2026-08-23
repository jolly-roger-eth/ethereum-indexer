import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';

/**
 * Every package named by a pending changeset must exist in the workspace.
 *
 * A file in `.changeset/` is not a historical record, it is an UNCONSUMED
 * release intent: `changeset version` reads it, writes it into the named
 * packages' `CHANGELOG.md` and deletes it. So a changeset naming a package that
 * is no longer in the workspace is not stale documentation, it is a release that
 * cannot be cut. `changeset status` fails outright with `Found changeset X for
 * package Y which is not in the workspace`, and so do `version` and `publish`.
 *
 * The reason this needs a test is that the acceptance gate runs
 * `changeset status --since=main`, which only assembles a plan for changesets
 * ADDED since main. A changeset that went stale on main (because the package it
 * names was renamed or retired underneath it) is invisible to that form and
 * surfaces only when someone runs a plain `changeset status` or tries to
 * release. That is exactly how ~30 of them accumulated across three generations
 * of package names before anyone noticed (ADR-0014, ADR-0017).
 *
 * It lives in the core package's suite for the same reason
 * `publishedTypeDependencies.test.ts` does: there is no workspace-level test
 * harness, and the failure message names the offending file.
 */

const ROOT = new URL('../../../', import.meta.url).pathname;

/** The `pnpm-workspace.yaml` globs, which are all of the form `<dir>/*`. */
const WORKSPACE_DIRECTORIES = ['packages', 'examples', 'platforms'];

function workspacePackageNames(): Set<string> {
	const names = new Set<string>();
	for (const directory of WORKSPACE_DIRECTORIES) {
		const parent = join(ROOT, directory);
		if (!existsSync(parent)) continue;
		for (const entry of readdirSync(parent, {withFileTypes: true})) {
			if (!entry.isDirectory()) continue;
			const manifestPath = join(parent, entry.name, 'package.json');
			if (!existsSync(manifestPath)) continue;
			const name = JSON.parse(readFileSync(manifestPath, 'utf-8')).name;
			if (typeof name === 'string') names.add(name);
		}
	}
	return names;
}

/**
 * The package names in a changeset's YAML front matter. Deliberately a small
 * line reader rather than a YAML dependency: the front matter changesets writes
 * is always `'<name>': <bump>` on one line.
 */
function packagesNamedBy(source: string): string[] {
	const lines = source.split('\n');
	if (lines[0].trim() !== '---') return [];
	const end = lines.indexOf('---', 1);
	if (end === -1) return [];
	return lines
		.slice(1, end)
		.map((line) => line.match(/^\s*['"]?(@?[^'":]+)['"]?\s*:/)?.[1]?.trim())
		.filter((name): name is string => !!name);
}

const changesetFiles = readdirSync(join(ROOT, '.changeset'))
	.filter((name) => name.endsWith('.md') && name !== 'README.md')
	.sort();

describe('pending changesets name packages that exist', () => {
	const workspace = workspacePackageNames();

	it('finds the workspace packages', () => {
		expect(workspace.size).toBeGreaterThan(0);
	});

	for (const file of changesetFiles) {
		it(`${file}`, () => {
			const named = packagesNamedBy(readFileSync(join(ROOT, '.changeset', file), 'utf-8'));

			// An empty front matter is its own bug: `changeset version` consumes the
			// file and writes it nowhere, so the note is silently lost. It is the
			// shape left behind by deleting the last name from a changeset instead of
			// deleting the changeset.
			expect(named.length, `.changeset/${file} names no package, so releasing it would discard it`).toBeGreaterThan(0);

			const missing = named.filter((name) => !workspace.has(name));
			expect(
				missing,
				`.changeset/${file} names ${missing.join(', ')}, which ${
					missing.length === 1 ? 'is' : 'are'
				} not in the workspace, so \`pnpm changeset status\` and any release fail`,
			).toEqual([]);
		});
	}
});
