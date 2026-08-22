import {describe, it, expect, afterAll} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const pkgRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const generator = join(pkgRoot, 'sql2ts.cjs');

/**
 * Every hazard that has actually bitten this generator, in one file:
 *
 * - a BACKTICK and a `${`, which ended the template literal / opened an
 *   interpolation back when the generator interpolated raw text. A backtick in a
 *   SQL comment was enough to emit TypeScript that would not parse, and the
 *   resulting TS1005 pointed at a generated file this package gitignores.
 * - a TRAILING BACKSLASH, which escaped the character after it.
 * - a CRLF line ending, which is the subtle one: a template literal's COOKED
 *   value normalises \r\n to \n (ECMAScript, TV of LineTerminatorSequence), so
 *   the escape-then-interpolate fix that preceded the current implementation was
 *   still silently rewriting the exported string, with no error anywhere.
 *
 * Built as an explicit Buffer rather than a template literal in this file,
 * because writing it as a template literal here would hit the exact
 * normalisation the last case is meant to detect.
 */
const hazards = Buffer.from(
	'-- backtick ` interpolation ${nope} trailing backslash \\\r\n' +
		'CREATE TABLE IF NOT EXISTS Hazard (\n' +
		"    note TEXT NOT NULL DEFAULT 'quote \" and escaped backslash \\\\'\n" +
		');\n',
	'utf8',
);

const tmpDirs: string[] = [];

/**
 * Run the REAL generator the way the build runs it.
 *
 * `sql2ts.cjs` takes its input folder as an argument but hardcodes its output to
 * `./src/schema/ts/` relative to the process cwd, so the only way to run it
 * without writing into this package is to give it a different cwd. That is a
 * property of the generator we share verbatim with the upstream template, so the
 * test bends around it rather than the generator being refactored to suit the
 * test.
 */
function generateInto(sqlFolder: string): string {
	const cwd = mkdtempSync(join(tmpdir(), 'etherfold-sql2ts-'));
	tmpDirs.push(cwd);
	execFileSync(process.execPath, [generator, sqlFolder], {cwd, stdio: 'pipe'});
	return join(cwd, 'src', 'schema', 'ts');
}

afterAll(() => {
	for (const dir of tmpDirs) rmSync(dir, {recursive: true, force: true});
});

describe('sql2ts round-trips SQL through a TypeScript module', () => {
	it('emits a module that parses, and exports the fixture byte for byte', async () => {
		const source = mkdtempSync(join(tmpdir(), 'etherfold-sql2ts-src-'));
		tmpDirs.push(source);
		const sqlFolder = join(source, 'sql');
		mkdirSync(sqlFolder);
		writeFileSync(join(sqlFolder, 'hazards.sql'), hazards);

		const outDir = generateInto(sqlFolder);

		// Importing is the parse check: a module that does not parse throws here,
		// and it is transformed as real TypeScript on the way in.
		const mod = await import(/* @vite-ignore */ pathToFileURL(join(outDir, 'hazards.sql.ts')).href);

		// Buffers, not strings: a string comparison of normalised text would pass
		// even if CRLF had been rewritten, which is the regression this exists for.
		expect(Buffer.from(mod.default as string, 'utf8')).toEqual(hazards);
	});

	it('round-trips the schema this package actually ships', async () => {
		const outDir = generateInto(join(pkgRoot, 'src', 'schema', 'sql'));
		const mod = await import(/* @vite-ignore */ pathToFileURL(join(outDir, 'db.sql.ts')).href);

		const onDisk = readFileSync(join(pkgRoot, 'src', 'schema', 'sql', 'db.sql'));
		expect(Buffer.from(mod.default as string, 'utf8')).toEqual(onDisk);
	});

	it('leaves this package untouched when it runs', () => {
		// The generator writes cwd-relative, so a test that got the cwd wrong would
		// silently overwrite the package's own generated schema instead of a temp
		// copy, and still pass. This pins the isolation itself.
		const before = readFileSync(join(pkgRoot, 'src', 'schema', 'sql', 'db.sql'));
		generateInto(join(pkgRoot, 'src', 'schema', 'sql'));
		expect(readFileSync(join(pkgRoot, 'src', 'schema', 'sql', 'db.sql'))).toEqual(before);
	});
});
