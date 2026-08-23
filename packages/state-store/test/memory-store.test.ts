import {describe, expect, it} from 'vitest';
import {MemoryStateStore} from '../src/index.js';
import {ACCOUNT, TOKEN, block, burn, owns} from './utils/fixtures.js';

/**
 * The reference backend: versioned rows in a Map.
 *
 * It exists so the CONTRACT has an executable definition that owes nothing to
 * SQL, and so a processor can be run against two backends in a test. Its
 * behaviour is deliberately the same as `@etherfold/state-store-sqlite`'s, down
 * to the sharp edges (a re-applied block raises, an unlisted field goes to
 * NULL), because a lenient reference implementation would let a caller bug
 * through here and fail in production.
 */

async function migrated(declarations = [TOKEN, ACCOUNT]): Promise<MemoryStateStore> {
	const store = new MemoryStateStore(declarations);
	await store.migrate();
	return store;
}

describe('versions are complete rows with a half-open validity range', () => {
	it('opens a version on write and closes it on the next one', async () => {
		const store = await migrated();
		await store.applyBlock(block(10), [owns('1', '0xalice', 1)]);
		await store.applyBlock(block(20), [owns('1', '0xbob', 2)]);

		expect(await store.getAsOf('token', {id: '1'}, 10)).toMatchObject({owner: '0xalice', _lower: 10, _upper: 20});
		expect(await store.getAsOf('token', {id: '1'}, 19)).toMatchObject({owner: '0xalice'});
		expect(await store.getAsOf('token', {id: '1'}, 20)).toMatchObject({owner: '0xbob', _lower: 20, _upper: null});
		expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xbob'});
	});

	it('answers `undefined` before the entity existed', async () => {
		const store = await migrated();
		await store.applyBlock(block(10), [owns('1', '0xalice', 1)]);
		expect(await store.getAsOf('token', {id: '1'}, 9)).toBeUndefined();
	});

	it('closes the live version on delete without opening a new one', async () => {
		const store = await migrated();
		await store.applyBlock(block(10), [owns('1', '0xalice', 1)]);
		await store.applyBlock(block(20), [burn('1')]);

		expect(await store.getCurrent('token', {id: '1'})).toBeUndefined();
		expect(await store.getAsOf('token', {id: '1'}, 19)).toMatchObject({owner: '0xalice'});
	});

	it('sets a declared field the mutation does not list to NULL', async () => {
		const store = await migrated();
		await store.applyBlock(block(10), [{type: 'upsert', entity: 'token', id: {id: '1'}, values: {owner: '0xalice'}}]);
		expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xalice', transferCount: null});
	});

	it('stores business keys as strings, so `1` and `"1"` are one entity', async () => {
		const store = await migrated();
		await store.applyBlock(block(10), [{type: 'upsert', entity: 'token', id: {id: 1}, values: {owner: '0xalice'}}]);
		expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xalice'});
	});
});

describe('revert', () => {
	it('drops versions opened above the fork and re-opens the ones it closed', async () => {
		const store = await migrated();
		await store.applyBlock(block(10), [owns('1', '0xalice', 1)]);
		await store.applyBlock(block(20), [owns('1', '0xbob', 2)]);

		await store.revertTo(15);

		// the canonical reorg bug this design exists to prevent: a counter that
		// does not decrease when its block is reverted.
		expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xalice', transferCount: 1});
		expect(await store.getBlock(20)).toBeUndefined();
		expect(await store.getBlock(10)).toMatchObject({number: 10});
	});

	it('brings a deleted entity back when the block that deleted it is reverted', async () => {
		const store = await migrated();
		await store.applyBlock(block(10), [owns('1', '0xalice', 1)]);
		await store.applyBlock(block(20), [burn('1')]);

		await store.revertTo(15);
		expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xalice'});
	});

	it('wipes everything at -1, since every version is opened at or above 0', async () => {
		const store = await migrated();
		await store.applyBlock(block(10), [owns('1', '0xalice', 1)]);
		await store.revertTo(-1);
		expect(await store.getCurrent('token', {id: '1'})).toBeUndefined();
		expect(await store.getBlock(10)).toBeUndefined();
	});
});

describe('the sharp edges are the same sharp edges', () => {
	it('raises when the same block is applied twice', async () => {
		const store = await migrated();
		await store.applyBlock(block(10), [owns('1', '0xalice', 1)]);
		await expect(store.applyBlock(block(10), [])).rejects.toThrow(/10/);
	});

	it('raises when a second hash claims a height that is already recorded', async () => {
		const store = await migrated();
		await store.applyBlock(block(10, '0xAAA'), []);
		await expect(store.applyBlock(block(10, '0xBBB'), [])).rejects.toThrow();
	});

	it('records a block that carried no mutation, because the caller decides which blocks exist', async () => {
		const store = await migrated();
		await store.applyBlock(block(10), []);
		expect(await store.getBlock(10)).toMatchObject({number: 10, hash: '0xa'});
	});

	it('rejects a mutation for an entity that was never declared', async () => {
		const store = await migrated();
		await expect(
			store.applyBlock(block(10), [{type: 'upsert', entity: 'ghost', id: {id: '1'}, values: {}}]),
		).rejects.toThrow(/ghost/);
	});

	it('rejects a declaration whose identifiers are not plain identifiers', () => {
		expect(() => new MemoryStateStore([{name: 'to"ken', id: ['id'], fields: {}}])).toThrow(/identifier/i);
		expect(() => new MemoryStateStore([{name: 'token', id: ['id'], fields: {_lower: 'integer'}}])).toThrow(/reserved/i);
	});

	it('applies a block atomically, so a rejected mutation leaves nothing behind', async () => {
		const store = await migrated();
		await expect(
			store.applyBlock(block(10), [
				owns('1', '0xalice', 1),
				{type: 'upsert', entity: 'ghost', id: {id: '1'}, values: {}},
			]),
		).rejects.toThrow(/ghost/);
		expect(await store.getCurrent('token', {id: '1'})).toBeUndefined();
		expect(await store.getBlock(10)).toBeUndefined();
	});
});

describe('capabilities are data, readable before any read is attempted', () => {
	it('reports what it keeps and what it can answer', async () => {
		const store = new MemoryStateStore([TOKEN]);
		// note: before `migrate`, before any write. That is the point of story 7.
		expect(store.capabilities).toEqual({retention: {kind: 'unbounded'}, asOf: true});
	});
});
