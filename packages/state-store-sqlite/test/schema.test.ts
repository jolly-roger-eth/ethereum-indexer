import {describe, expect, it} from 'vitest';
import {VersionedStateStore} from '../src/index.js';
import {createTestDB, rows} from './utils/db.js';
import {ACCOUNT, TOKEN, block, owns} from './utils/fixtures.js';

type SQLiteMaster = {type: string; name: string; tbl_name: string; sql: string | null};

async function schemaObjects(db: ReturnType<typeof createTestDB>) {
	return rows<SQLiteMaster>(db, `SELECT type, name, tbl_name, sql FROM sqlite_master`);
}

describe('entity DDL is issued from the declaration alone', () => {
	it('creates the entity table with the reserved version columns', async () => {
		const db = createTestDB();
		// The caller writes NO DDL: only `{name, id, fields}`.
		await new VersionedStateStore(db, [TOKEN]).migrate();

		const columns = await rows<{name: string; type: string; notnull: number}>(db, `PRAGMA table_info(token)`);
		const byName = Object.fromEntries(columns.map((c) => [c.name, c]));

		expect(Object.keys(byName).sort()).toEqual(['_lower', '_rowid', '_upper', 'id', 'owner', 'transferCount']);
		expect(byName['id'].type).toBe('TEXT');
		expect(byName['id'].notnull).toBe(1);
		expect(byName['owner'].type).toBe('TEXT');
		expect(byName['transferCount'].type).toBe('INTEGER');
		expect(byName['_lower'].type).toBe('INTEGER');
		expect(byName['_lower'].notnull).toBe(1);
		// _upper must be nullable: NULL is what "still valid at the tip" means.
		expect(byName['_upper'].notnull).toBe(0);
	});

	it('creates the partial unique index on open rows plus the as-of and revert indexes', async () => {
		const db = createTestDB();
		await new VersionedStateStore(db, [TOKEN]).migrate();

		const indexes = (await schemaObjects(db)).filter((o) => o.type === 'index' && o.tbl_name === 'token');
		const byName = Object.fromEntries(indexes.map((i) => [i.name, i.sql ?? '']));

		// the index names carry the store's `_` prefix, so they cannot collide with
		// an ENTITY named `token_open`: in SQLite an index and a table share one
		// namespace (`src/ddl.ts`, `test/reserved-names.test.ts`).
		expect(byName['_token_open']).toMatch(/UNIQUE INDEX/i);
		expect(byName['_token_open']).toMatch(/WHERE\s+_upper\s+IS\s+NULL/i);
		// as-of probes ride (id, _lower); revert scans ride _lower and _upper.
		// the declared columns are QUOTED, so a name that is a SQL keyword survives
		// interpolation (`src/identifiers.ts`, `test/identifiers.test.ts`).
		expect(byName['_token_history']).toMatch(/\("id",\s*_lower\)/i);
		expect(byName['_token_lower']).toMatch(/\(_lower\)/i);
		expect(byName['_token_upper']).toMatch(/\(_upper\)/i);
	});

	it('creates the canonical block table', async () => {
		const db = createTestDB();
		await new VersionedStateStore(db, [TOKEN]).migrate();

		const blocks = (await schemaObjects(db)).find((o) => o.type === 'table' && o.name === '_blocks');
		expect(blocks?.sql).toMatch(/number\s+INTEGER\s+PRIMARY KEY/i);
		expect(blocks?.sql).toMatch(/hash\s+TEXT\s+NOT NULL\s+UNIQUE/i);
	});

	it('is idempotent, so migrate can run on every boot', async () => {
		const db = createTestDB();
		const store = new VersionedStateStore(db, [TOKEN, ACCOUNT]);
		await store.migrate();
		await expect(store.migrate()).resolves.not.toThrow();
	});

	it('handles a composite business key', async () => {
		const db = createTestDB();
		const store = new VersionedStateStore(db, [
			{name: 'holding', id: ['account', 'token'], fields: {amount: 'integer'}},
		]);
		await store.migrate();

		const index = (await schemaObjects(db)).find((o) => o.name === '_holding_open');
		expect(index?.sql).toMatch(/\("account",\s*"token"\)/i);

		await store.applyBlock(block(10), [
			{type: 'upsert', entity: 'holding', id: {account: '0xa', token: '1'}, values: {amount: 5}},
		]);
		const found = await store.getAsOf<{amount: number}>('holding', {account: '0xa', token: '1'}, 10);
		expect(found?.amount).toBe(5);
	});

	it('rejects declarations whose identifiers are not plain identifiers', () => {
		const db = createTestDB();
		// Entity declarations come from a processor, and identifiers cannot be bound
		// parameters, so they are validated instead of interpolated blindly.
		expect(() => new VersionedStateStore(db, [{name: 'to"ken', id: ['id'], fields: {}}])).toThrow(/identifier/i);
		expect(() => new VersionedStateStore(db, [{name: 'token', id: ['id'], fields: {'a-b': 'text'}}])).toThrow(
			/identifier/i,
		);
		// the reserved namespace stays the store's own
		expect(() => new VersionedStateStore(db, [{name: 'token', id: ['id'], fields: {_lower: 'integer'}}])).toThrow(
			/reserved/i,
		);
	});

	it('rejects a mutation for an entity that was never declared', async () => {
		const db = createTestDB();
		const store = new VersionedStateStore(db, [TOKEN]);
		await store.migrate();
		await expect(
			store.applyBlock(block(1), [{type: 'upsert', entity: 'ghost', id: {id: '1'}, values: {}}]),
		).rejects.toThrow(/ghost/);
	});

	it('rejects a mutation missing part of its business key', async () => {
		const db = createTestDB();
		const store = new VersionedStateStore(db, [TOKEN]);
		await store.migrate();
		await expect(store.applyBlock(block(1), [owns(undefined as unknown as string, '0xA', 1)])).rejects.toThrow(/id/i);
	});
});
