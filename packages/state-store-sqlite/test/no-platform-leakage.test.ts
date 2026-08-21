import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';

/**
 * The store targets the `remote-sql` interface, and one hosted SQLite backend is
 * one backend among several, never the target. This is a review criterion that
 * is easy to state and easy to erode, so it is asserted instead.
 *
 * (This test reads the filesystem; the *published* source it inspects does not.)
 */

const SRC = new URL('../src/', import.meta.url).pathname;

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return sourceFiles(path);
		return entry.name.endsWith('.ts') ? [path] : [];
	});
}

describe('the package stays platform agnostic', () => {
	const files = sourceFiles(SRC);

	it('has source files to check', () => {
		expect(files.length).toBeGreaterThan(0);
	});

	it('imports nothing but remote-sql and named-logs', () => {
		const allowed = new Set(['remote-sql', 'named-logs']);
		for (const file of files) {
			const source = readFileSync(file, 'utf-8');
			for (const match of source.matchAll(/^\s*import\s+(?:type\s+)?.*?from\s+'([^']+)'/gm)) {
				const specifier = match[1];
				if (specifier.startsWith('.')) continue;
				expect(allowed.has(specifier), `${file} imports ${specifier}`).toBe(true);
			}
		}
	});

	it('names no specific hosted backend and uses no runtime built-in', () => {
		for (const file of files) {
			const source = readFileSync(file, 'utf-8');
			expect(source, file).not.toMatch(/\bD1\b/);
			expect(source, file).not.toMatch(/cloudflare/i);
			expect(source, file).not.toMatch(/from '(node|bun|cloudflare):/);
			expect(source, file).not.toMatch(/\bconsole\./);
		}
	});

	it('declares only remote-sql and named-logs as runtime dependencies', () => {
		const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url).pathname, 'utf-8'));
		expect(Object.keys(pkg.dependencies).sort()).toEqual(['named-logs', 'remote-sql']);
	});
});
