import {beforeEach, describe, expect, it} from 'vitest';
import {VersionedStateStore} from '../src/index.js';
import {createTestDB, rows} from './utils/db.js';
import {TOKEN, block, burn, owns} from './utils/fixtures.js';

// One token, three owners, so the key has several versions to travel through:
//   [100, 101) Alice   [101, 102) Bob   [102, ...) Carol
async function threeVersions() {
	const db = createTestDB();
	const store = new VersionedStateStore(db, [TOKEN]);
	await store.migrate();
	await store.applyBlock(block(100), [owns('1', '0xAlice', 1)]);
	await store.applyBlock(block(101), [owns('1', '0xBob', 2)]);
	await store.applyBlock(block(102), [owns('1', '0xCarol', 3)]);
	return {db, store};
}

describe('reading as of a block', () => {
	let store: VersionedStateStore;
	let db: ReturnType<typeof createTestDB>;

	beforeEach(async () => {
		({db, store} = await threeVersions());
	});

	it('returns the value that was live at that block', async () => {
		expect((await store.getAsOf<{owner: string}>('token', {id: '1'}, 100))?.owner).toBe('0xAlice');
		expect((await store.getAsOf<{owner: string}>('token', {id: '1'}, 101))?.owner).toBe('0xBob');
		expect((await store.getAsOf<{owner: string}>('token', {id: '1'}, 102))?.owner).toBe('0xCarol');
	});

	it('is inclusive at the block a version opened and exclusive at the block it closed', async () => {
		// version [101, 102): live AT 101 (the block that opened it),
		// and NOT live at 102 (the block that closed it) — half-open range.
		const at101 = await store.getAsOf<{owner: string}>('token', {id: '1'}, 101);
		const at102 = await store.getAsOf<{owner: string}>('token', {id: '1'}, 102);
		expect(at101?.owner).toBe('0xBob');
		expect(at102?.owner).not.toBe('0xBob');
	});

	it('returns nothing before the entity existed', async () => {
		expect(await store.getAsOf('token', {id: '1'}, 99)).toBeUndefined();
	});

	it('returns the tip value for any block at or after the last change', async () => {
		expect((await store.getAsOf<{owner: string}>('token', {id: '1'}, 5_000))?.owner).toBe('0xCarol');
	});

	it('never returns more than one version for a key at a given block', async () => {
		for (const n of [100, 101, 102, 103]) {
			const all = await rows(
				db,
				`SELECT * FROM token WHERE id = ? AND _lower <= ? AND (_upper IS NULL OR ? < _upper)`,
				'1',
				n,
				n,
			);
			expect(all.length, `block ${n}`).toBe(1);
		}
	});

	it('reads current state as the open-row special case', async () => {
		const current = await store.getCurrent<{owner: string; transferCount: number}>('token', {id: '1'});
		expect(current?.owner).toBe('0xCarol');
		expect(current?.transferCount).toBe(3);
	});

	it('queries a whole entity as of a block', async () => {
		await store.applyBlock(block(103), [owns('2', '0xDave', 1)]);
		const at102 = await store.queryAsOf<{id: string}>('token', 102);
		const at103 = await store.queryAsOf<{id: string}>('token', 103);
		expect(at102.map((t) => t.id).sort()).toEqual(['1']);
		expect(at103.map((t) => t.id).sort()).toEqual(['1', '2']);
	});

	it('supports a filter, an order and a limit on an as-of query', async () => {
		await store.applyBlock(block(103), [owns('2', '0xDave', 1), owns('3', '0xDave', 1)]);
		const dave = await store.queryAsOf<{id: string}>('token', 103, {
			where: 'owner = ?',
			args: ['0xDave'],
			orderBy: 'id DESC',
			limit: 1,
		});
		expect(dave.map((t) => t.id)).toEqual(['3']);
	});
});

describe('deleting an entity', () => {
	it('is just the close: absent afterwards, still present as of before', async () => {
		const {store} = await threeVersions();
		await store.applyBlock(block(103), [burn('1')]);

		expect(await store.getCurrent('token', {id: '1'})).toBeUndefined();
		expect(await store.getAsOf('token', {id: '1'}, 103)).toBeUndefined();
		expect((await store.getAsOf<{owner: string}>('token', {id: '1'}, 102))?.owner).toBe('0xCarol');
	});
});

describe('one live version per business key', () => {
	it('is enforced by the partial unique index, not by convention', async () => {
		const db = createTestDB();
		const store = new VersionedStateStore(db, [TOKEN]);
		await store.migrate();
		await store.applyBlock(block(100), [owns('1', '0xAlice', 1)]);

		// A hand-written second open row for the same key must be rejected by the DB.
		await expect(
			db
				.prepare(`INSERT INTO token (id, owner, transferCount, _lower) VALUES (?, ?, ?, ?)`)
				.bind('1', '0xEve', 1, 101)
				.all(),
		).rejects.toThrow(/UNIQUE|constraint/i);

		// Two open rows for DIFFERENT keys are of course fine.
		await expect(
			db
				.prepare(`INSERT INTO token (id, owner, transferCount, _lower) VALUES (?, ?, ?, ?)`)
				.bind('2', '0xEve', 1, 101)
				.all(),
		).resolves.toBeDefined();
	});

	it('holds after a normal close-then-insert write', async () => {
		const {db} = await threeVersions();
		const open = await rows(db, `SELECT * FROM token WHERE id = ? AND _upper IS NULL`, '1');
		expect(open.length).toBe(1);
	});
});
