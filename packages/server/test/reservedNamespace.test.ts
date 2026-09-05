import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';

// ---------------------------------------------------------------------------
// EVERY FIXED TABLE LIVES IN THE RESERVED `_` NAMESPACE
// ---------------------------------------------------------------------------
// A processor's ENTITY tables are created as `CREATE TABLE IF NOT EXISTS
// "<entity.name>"` (`@etherfold/state-store-sqlite`) against the SAME database
// handle this package's fixed tables live in: `buildProcessor` hands one handle
// to both the store and the server in every combined shape. So a fixed table
// whose name a processor could also DECLARE is a silent collision -- the DDL
// succeeds because of `IF NOT EXISTS`, and the failure arrives much later as a
// column error on a write, nowhere near the declaration that caused it.
//
// `@etherfold/state-store` already refuses an entity whose name starts with `_`
// (`isReserved`), and the store's own fixed tables already sit there as
// `_blocks` and `_cursor`. Putting this package's there too closes the
// collision by CONSTRUCTION, with no new API and no second refusal that would
// have to be told these names.
//
// A rename fixes today's tables and leaves tomorrow's to memory, which is what
// this file is for: the convention becomes a GUARANTEE, so a fixed table added
// later without the prefix fails the gate rather than shipping a collision. It
// is the same move `packages/core/test/oneReorgWriteSite.test.ts` makes -- a
// cheap source-level assertion standing in for a structural property.
//
// It reads the `.sql` FILE rather than the generated module or a live database,
// because the file is what BOTH application paths consume: `applySchema` runs
// the statements parsed out of it, and wrangler's D1 migration runs the file
// itself and calls nothing of ours.
// ---------------------------------------------------------------------------

const SCHEMA_FILE = 'src/schema/sql/db.sql';
const schema = readFileSync(new URL(`../${SCHEMA_FILE}`, import.meta.url), 'utf-8');

/**
 * The DDL with the prose removed.
 *
 * The comments go first for the same reason `schemaStatements` strips them
 * before splitting: this file is mostly comments, and one of them says the words
 * `CREATE TABLE` while describing what is deliberately NOT here.
 */
const ddl = schema.replace(/--[^\n]*/g, '');

/** What one `CREATE` in the DDL brings into existence: its kind and the name it takes. */
type Created = {kind: string; name: string};

/**
 * Every table and index the file creates.
 *
 * SQLite puts tables and indexes in ONE namespace, so they are scanned together
 * and held to one rule. The optional `IF NOT EXISTS` and the optional quoting are
 * both matched rather than assumed, so a statement spelled a legal but unusual
 * way is READ rather than skipped -- a skipped statement is exactly how a scan
 * like this passes while the thing it checks is false.
 */
const created: Created[] = [
	...ddl.matchAll(/CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`[]?([A-Za-z_][A-Za-z0-9_$]*)/gi),
].map((match) => ({kind: match[1]!.toUpperCase(), name: match[2]!}));

describe('the fixed schema', () => {
	it('is actually being scanned, and every CREATE in it was parsed', () => {
		// The guard, and the reason it is two assertions: the first fails if the file
		// moves or empties (a scan that finds nothing must not pass), and the second
		// fails if the file grows a `CREATE` this regex cannot read, which would let a
		// new table slip past the rule below while the suite stayed green.
		expect(created.length).toBeGreaterThanOrEqual(4);
		expect(created).toEqual(expect.arrayContaining([expect.objectContaining({kind: 'TABLE'})]));
		expect(created).toEqual(expect.arrayContaining([expect.objectContaining({kind: 'INDEX'})]));
		expect(created).toHaveLength((ddl.match(/\bCREATE\b/gi) ?? []).length);
	});

	it('creates every table and index inside the reserved `_` namespace', () => {
		const outside = created.filter((entry) => !entry.name.startsWith('_'));

		// named rather than counted, so a failure says WHICH one forgot the prefix
		expect(outside).toEqual([]);
	});

	it('would notice a fixed table that forgot the prefix', () => {
		// the negative control: the rule above is only worth having if the scan can
		// FAIL, and a regex that quietly matches nothing passes every list-is-empty
		// assertion ever written
		const forgetful = `-- a later table, added without the prefix\nCREATE TABLE IF NOT EXISTS Sessions (id TEXT PRIMARY KEY);\nCREATE INDEX SessionsById ON Sessions (id);`;
		const names = [
			...forgetful
				.replace(/--[^\n]*/g, '')
				.matchAll(/CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`[]?([A-Za-z_][A-Za-z0-9_$]*)/gi),
		].map((match) => match[2]!);

		expect(names.filter((name) => !name.startsWith('_'))).toEqual(['Sessions', 'SessionsById']);
	});

	it('leaves no trace of the names those tables used to have', () => {
		// `Meta` and `EmissionStream` were outside the namespace and were the only two
		// unprotected fixed tables in the project. There is no migration and no
		// compatibility read: an older database simply reports the schema as unapplied,
		// because the `schemaVersion` row lived in the table that was renamed.
		expect(schema).not.toMatch(/\bMeta\b/);
		expect(schema).not.toMatch(/EmissionStream/);
	});
});
