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

// ---------------------------------------------------------------------------
// THE INGEST TOKEN IS NOT COMPARED WITH `===`
// ---------------------------------------------------------------------------
// Timing safety is not observable in an outcome, so it cannot be asserted
// behaviourally: a test that compares two tokens sees the same 401 whichever
// comparison produced it. This package already guards unobservable properties by
// reading its own source (the platform rules above), so the same technique
// applies to the one security property that has no other witness.
// ---------------------------------------------------------------------------

describe('the ingest token comparison', () => {
	const source = readFileSync(join(pkgRoot, 'src/api/ingest.ts'), 'utf-8');

	it('accumulates a difference over every character rather than short-circuiting', () => {
		// the shape of a constant-time compare: XOR into an accumulator, one test at
		// the end. `a === b` and `a !== b` on the secrets would both leak WHERE they
		// first differ.
		expect(source).toMatch(/difference \|= a\.charCodeAt\(i\) \^ b\.charCodeAt\(i\)/);
		expect(source).toMatch(/return difference === 0/);
	});

	it('is what the request path actually calls', () => {
		// the guard above is worth nothing if the auth check stopped using it
		expect(source).toMatch(/secretEquals\(/);
	});
});
