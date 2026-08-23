import {describe, expect, it} from 'vitest';
import {VersionedStateStore} from '../src/index.js';
import {createTestDB, rows} from './utils/db.js';
import {ACCOUNT, TOKEN, block, burn, owns} from './utils/fixtures.js';

/**
 * What revert MEANS -- a closed version live again, a counter back DOWN, an
 * entity created above the fork gone, the same height replayable afterwards --
 * is the seam's, and `@etherfold/state-store-conformance` asserts it against
 * every backend (see `conformance.test.ts`). It is not restated here.
 *
 * What is left is what revert does to the ROWS, which only this backend has:
 * that no version survives above the fork in either bound, that the dead blocks
 * leave the canonical block table, and that exactly one version per key is open
 * afterwards. Those are the invariants a wrong revert would break silently while
 * still answering every external question correctly for a while.
 */

async function indexedChain() {
	const db = createTestDB();
	const store = new VersionedStateStore(db, [TOKEN, ACCOUNT]);
	await store.migrate();
	await store.applyBlock(block(100), [owns('1', '0xAlice', 1)]);
	await store.applyBlock(block(101), [owns('1', '0xBob', 2), owns('2', '0xZoe', 1)]);
	await store.applyBlock(block(102), [owns('1', '0xCarol', 3)]);
	await store.applyBlock(block(103), [owns('1', '0xDan', 4), burn('2')]);
	return {db, store};
}

describe('revertTo, in the rows', () => {
	it('restores exactly the state the as-of query gave for the fork block', async () => {
		const {store} = await indexedChain();
		const before = await store.queryAsOf<{id: string; owner: string}>('token', 101);

		await store.revertTo(101);

		// the whole-table read is this backend's own surface, so the equality
		// between "as of 101" and "current, after reverting to 101" is asserted here
		const after = await store.queryCurrent<{id: string; owner: string}>('token');
		expect(after.map((t) => `${t.id}:${t.owner}`).sort()).toEqual(before.map((t) => `${t.id}:${t.owner}`).sort());
	});

	it('drops every version born above the fork', async () => {
		const {db, store} = await indexedChain();
		await store.revertTo(101);
		expect(await rows(db, `SELECT * FROM token WHERE _lower > ?`, 101)).toEqual([]);
		expect(await rows(db, `SELECT * FROM token WHERE _upper > ?`, 101)).toEqual([]);
	});

	it('removes the dead blocks from the canonical block table', async () => {
		const {db, store} = await indexedChain();
		await store.revertTo(101);
		const kept = await rows<{number: number}>(db, `SELECT number FROM _blocks ORDER BY number`);
		expect(kept.map((b) => b.number)).toEqual([100, 101]);
	});

	it('leaves exactly one live version per key afterwards', async () => {
		const {db, store} = await indexedChain();
		await store.revertTo(101);
		const open = await rows<{id: string}>(db, `SELECT id FROM token WHERE _upper IS NULL ORDER BY id`);
		expect(open.map((t) => t.id)).toEqual(['1', '2']);
	});

	it('empties the tables without touching the schema when it reverts below everything', async () => {
		const {db, store} = await indexedChain();
		await store.revertTo(0);
		expect(await rows(db, `SELECT * FROM token`)).toEqual([]);
		expect(await rows(db, `SELECT * FROM _blocks`)).toEqual([]);
		// still usable: the tables are still there
		await store.applyBlock(block(100), [owns('1', '0xAlice', 1)]);
		expect((await store.getCurrent<{owner: string}>('token', {id: '1'}))?.owner).toBe('0xAlice');
	});
});
