import {describe, it, expect} from 'vitest';
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const pkgRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) return sourceFiles(full);
		return full.endsWith('.ts') ? [full] : [];
	});
}

/**
 * ADR-0003's split only holds if the server names no runtime. `platforms/*` is
 * where a runtime is allowed to appear, and the whole design collapses quietly
 * if something leaks back in here: the code keeps working on the host the author
 * happened to test, and fails on the other one.
 *
 * So this is asserted, not assumed, per the task's own acceptance criterion.
 */
describe('the server package names no runtime', () => {
	const forbidden = [
		{pattern: /from ['"]node:/, why: 'a Node built-in'},
		{pattern: /from ['"]@cloudflare\//, why: 'a Cloudflare type package'},
		{pattern: /from ['"]@hono\/node-server['"]/, why: 'the Node HTTP host'},
		{pattern: /from ['"]@libsql\/client['"]/, why: 'a concrete database driver'},
		{pattern: /from ['"]remote-sql-(libsql|d1)['"]/, why: 'a concrete RemoteSQL backend'},
		{pattern: /\bD1Database\b/, why: 'a D1 type'},
	];

	const files = sourceFiles(join(pkgRoot, 'src'));

	it('has source files to check (guards against this test silently passing on an empty scan)', () => {
		expect(files.length).toBeGreaterThan(4);
	});

	for (const {pattern, why} of forbidden) {
		it(`imports no ${why}`, () => {
			const offenders = files.filter((f) => pattern.test(readFileSync(f, 'utf-8')));
			expect(offenders.map((f) => f.slice(pkgRoot.length + 1))).toEqual([]);
		});
	}

	it('declares no host dependency in package.json', () => {
		const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf-8'));
		// devDependencies MAY name a backend: the tests need one to run against.
		// Runtime dependencies may not, because those are what a consumer installs.
		//
		// `@etherfold/core` is on the list and is not a host: it is the engine whose
		// stream-builder this app routes HTTP to, and it names no runtime either
		// (nothing in it imports a Node built-in or a driver). The list is exhaustive
		// rather than a deny-list so that ADDING a dependency is a decision somebody
		// makes here, in the file that explains why the property matters.
		expect(Object.keys(pkg.dependencies).sort()).toEqual(['@etherfold/core', 'hono', 'named-logs', 'remote-sql']);
	});
});
