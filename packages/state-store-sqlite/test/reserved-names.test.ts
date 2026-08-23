import {describe, expect, it} from 'vitest';
import {VersionedStateStore} from '../src/index.js';
import {createTestDB, rows} from './utils/db.js';
import {TOKEN, block} from './utils/fixtures.js';

/**
 * The two ways a legally-shaped name could still not become a table HERE, and
 * what each of them was turned into.
 *
 * Both are instances of the class `entity-identifier-sql-keyword` opened: a
 * declaration whose legality depended on which backend stored it. Neither is
 * reachable by quoting, which is why they are answered differently from the
 * keyword half.
 *
 * - An entity named like another entity's derived INDEX. In SQLite an index and
 *   a table share one namespace, so `token` + `token_open` was fatal at
 *   `migrate()` here and two ordinary entities everywhere else. Fixed by
 *   CONSTRUCTION: the derived index names moved into the store's `_` namespace,
 *   which the seam already keeps a declaration out of. The declaration is now
 *   legal on every backend, which is the better of the two outcomes.
 * - An entity in SQLite's OWN `sqlite_` namespace, which the engine refuses
 *   however it is quoted. Nothing this package emits can rescue it, so it is
 *   refused at DECLARATION time -- when the store is constructed -- rather than
 *   at `migrate()` on a deployed server. The seam does NOT learn this rule: it
 *   is one engine's namespace, exactly like the reserved-word list that was
 *   deliberately kept out of `@etherfold/state-store`.
 */

describe('an entity named like this store derived index names', () => {
	it('migrates beside the entity it would have collided with', async () => {
		const db = createTestDB();
		// before the `_` prefix: `SQLITE_ERROR: there is already an index named token_open`
		const store = new VersionedStateStore(db, [TOKEN, {name: 'token_open', id: ['id'], fields: {owner: 'text'}}]);
		await expect(store.migrate()).resolves.not.toThrow();

		const objects = await rows<{type: string; name: string}>(
			db,
			`SELECT type, name FROM sqlite_master WHERE name IN ('token', 'token_open', '_token_open')`,
		);
		expect(
			objects
				.filter((o) => o.type === 'table')
				.map((o) => o.name)
				.sort(),
		).toEqual(['token', 'token_open']);
		expect(objects.find((o) => o.name === '_token_open')?.type).toBe('index');
	});

	it('stays a separate entity through a write and a read', async () => {
		const db = createTestDB();
		const store = new VersionedStateStore(db, [TOKEN, {name: 'token_open', id: ['id'], fields: {owner: 'text'}}]);
		await store.migrate();

		await store.applyBlock(block(100), [
			{type: 'upsert', entity: 'token', id: {id: '1'}, values: {owner: '0xa', transferCount: 1}},
			{type: 'upsert', entity: 'token_open', id: {id: '1'}, values: {owner: '0xb'}},
		]);

		expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xa'});
		expect(await store.getCurrent('token_open', {id: '1'})).toMatchObject({owner: '0xb'});
	});

	it('holds for every derived index, not only the open one', async () => {
		const db = createTestDB();
		const suffixes = ['open', 'history', 'lower', 'upper'];
		const store = new VersionedStateStore(db, [
			TOKEN,
			...suffixes.map((suffix) => ({name: `token_${suffix}`, id: ['id'], fields: {owner: 'text' as const}})),
		]);
		await expect(store.migrate()).resolves.not.toThrow();
	});
});

describe('an entity in SQLite own `sqlite_` namespace', () => {
	it('is refused when the store is CONSTRUCTED, not at migrate()', () => {
		const db = createTestDB();
		// `CREATE TABLE "sqlite_thing" (...)` is
		// `SQLITE_ERROR: object name reserved for internal use`, quoted or not.
		expect(() => new VersionedStateStore(db, [{name: 'sqlite_thing', id: ['id'], fields: {}}])).toThrow(
			/reserves object names beginning with "sqlite_"/i,
		);
	});

	it('names the entity and says to rename it', () => {
		const db = createTestDB();
		expect(() => new VersionedStateStore(db, [{name: 'sqlite_stat1', id: ['id'], fields: {}}])).toThrow(
			/sqlite_stat1[\s\S]*[Rr]ename/,
		);
	});

	it('matches the prefix the way SQLite does, case-insensitively', () => {
		const db = createTestDB();
		expect(() => new VersionedStateStore(db, [{name: 'SQLite_Thing', id: ['id'], fields: {}}])).toThrow(/reserve/i);
		// and no further: the prefix is `sqlite_`, not `sqlite`
		expect(() => new VersionedStateStore(db, [{name: 'sqlitex', id: ['id'], fields: {}}])).not.toThrow();
	});

	it('does not narrow the seam for a COLUMN, which SQLite is happy with', async () => {
		const db = createTestDB();
		const store = new VersionedStateStore(db, [{name: 'strained', id: ['sqlite_key'], fields: {sqlite_value: 'text'}}]);
		await expect(store.migrate()).resolves.not.toThrow();

		await store.applyBlock(block(100), [
			{type: 'upsert', entity: 'strained', id: {sqlite_key: 'k'}, values: {sqlite_value: 'v'}},
		]);
		expect(await store.getCurrent('strained', {sqlite_key: 'k'})).toMatchObject({sqlite_value: 'v'});
	});
});

describe('an identifier length', () => {
	it('is not limited by this backend, so the seam does not limit it either', async () => {
		const db = createTestDB();
		const long = `long${'x'.repeat(196)}`;
		const store = new VersionedStateStore(db, [{name: long, id: [`${long}Key`], fields: {[`${long}Field`]: 'text'}}]);
		await expect(store.migrate()).resolves.not.toThrow();

		await store.applyBlock(block(100), [
			{type: 'upsert', entity: long, id: {[`${long}Key`]: 'k'}, values: {[`${long}Field`]: 'v'}},
		]);
		expect(await store.getCurrent(long, {[`${long}Key`]: 'k'})).toMatchObject({[`${long}Field`]: 'v'});
	});
});
