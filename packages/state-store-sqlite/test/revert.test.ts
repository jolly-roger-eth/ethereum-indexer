import {describe, expect, it} from 'vitest';
import {VersionedStateStore} from '../src/index.js';
import {createTestDB, rows} from './utils/db.js';
import {ACCOUNT, TOKEN, block, burn, owns} from './utils/fixtures.js';

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

describe('revertTo', () => {
	it('restores exactly the state as of the fork block', async () => {
		const {store} = await indexedChain();
		const before = await store.queryAsOf<{id: string; owner: string}>('token', 101);

		await store.revertTo(101);

		expect((await store.getCurrent<{owner: string}>('token', {id: '1'}))?.owner).toBe('0xBob');
		// entity 2 was deleted on the dead branch: the delete must be undone too
		expect((await store.getCurrent<{owner: string}>('token', {id: '2'}))?.owner).toBe('0xZoe');
		const after = await store.queryCurrent<{id: string; owner: string}>('token');
		expect(after.map((t) => `${t.id}:${t.owner}`).sort()).toEqual(before.map((t) => `${t.id}:${t.owner}`).sort());
	});

	it('leaves history strictly below the fork untouched and still queryable', async () => {
		const {store} = await indexedChain();
		await store.revertTo(101);

		expect((await store.getAsOf<{owner: string}>('token', {id: '1'}, 100))?.owner).toBe('0xAlice');
		expect((await store.getAsOf<{owner: string}>('token', {id: '1'}, 101))?.owner).toBe('0xBob');
		expect(await store.getAsOf('token', {id: '1'}, 99)).toBeUndefined();
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

	it('lets the canonical branch replay normally after the fork', async () => {
		const {store} = await indexedChain();
		await store.revertTo(101);
		await store.applyBlock(block(102, '0xc2'), [owns('1', '0xErin', 3)]);

		expect((await store.getAsOf<{owner: string}>('token', {id: '1'}, 102))?.owner).toBe('0xErin');
		expect((await store.getAsOf<{owner: string}>('token', {id: '1'}, 101))?.owner).toBe('0xBob');
		expect((await store.getAsOf<{owner: string}>('token', {id: '1'}, 100))?.owner).toBe('0xAlice');
	});

	it('reverting to a block below everything empties the state without touching the schema', async () => {
		const {db, store} = await indexedChain();
		await store.revertTo(0);
		expect(await rows(db, `SELECT * FROM token`)).toEqual([]);
		expect(await rows(db, `SELECT * FROM _blocks`)).toEqual([]);
		// still usable
		await store.applyBlock(block(100), [owns('1', '0xAlice', 1)]);
		expect((await store.getCurrent<{owner: string}>('token', {id: '1'}))?.owner).toBe('0xAlice');
	});

	it('is a no-op above the tip', async () => {
		const {store} = await indexedChain();
		await store.revertTo(9_999);
		expect((await store.getCurrent<{owner: string}>('token', {id: '1'}))?.owner).toBe('0xDan');
	});

	it('reverts every declared entity, not just the ones that changed', async () => {
		const db = createTestDB();
		const store = new VersionedStateStore(db, [TOKEN, ACCOUNT]);
		await store.migrate();
		await store.applyBlock(block(100), [
			{type: 'upsert', entity: 'account', id: {address: '0xa'}, values: {balance: 1}},
		]);
		await store.applyBlock(block(101), [
			{type: 'upsert', entity: 'account', id: {address: '0xa'}, values: {balance: 2}},
		]);

		await store.revertTo(100);
		expect((await store.getCurrent<{balance: number}>('account', {address: '0xa'}))?.balance).toBe(1);
	});
});
