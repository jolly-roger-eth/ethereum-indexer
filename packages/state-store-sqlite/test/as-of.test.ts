import {describe, expect, it} from 'vitest';
import {VersionedStateStore} from '../src/index.js';
import {createTestDB, rows} from './utils/db.js';
import {TOKEN, block, owns} from './utils/fixtures.js';

/**
 * What is left here is what only THIS backend can be asked.
 *
 * The behaviour of an as-of read -- which version answers at which block, the
 * half-open range, an entity absent before it existed, a delete readable as of
 * any earlier block -- is the seam's and is asserted for every backend by
 * `@etherfold/state-store-conformance` (see `conformance.test.ts`). Keeping a
 * second copy of those cases here would be keeping a second answer to the same
 * question, which is the drift the shared suite exists to prevent.
 *
 * These remain because they are about the versioned-row REPRESENTATION: the
 * whole-table query surface that takes caller-supplied SQL and is deliberately
 * not at the seam, and the invariants a reader can only check by looking at the
 * rows.
 */

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

describe('the whole-table query surface, which belongs to this backend alone', () => {
	it('queries a whole entity as of a block', async () => {
		const {store} = await threeVersions();
		await store.applyBlock(block(103), [owns('2', '0xDave', 1)]);
		const at102 = await store.queryAsOf<{id: string}>('token', 102);
		const at103 = await store.queryAsOf<{id: string}>('token', 103);
		expect(at102.map((t) => t.id).sort()).toEqual(['1']);
		expect(at103.map((t) => t.id).sort()).toEqual(['1', '2']);
	});

	it('supports a filter, an order and a limit on an as-of query', async () => {
		const {store} = await threeVersions();
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

describe('one live version per business key', () => {
	it('never returns more than one version for a key at a given block', async () => {
		const {db} = await threeVersions();
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
