import {describe, expect, it} from 'vitest';
import {MemoryStateStore, createMutationContext} from '../src/index.js';
import {TOKEN, block} from './utils/fixtures.js';

/**
 * The write surface, tested AT THE SEAM rather than through any one backend.
 *
 * These are the properties a handler author relies on, and they must hold for
 * every backend because they are implemented once, here, above the backend
 * interface. The SQLite path gets them by construction; a future IndexedDB or
 * light backend gets them the same way.
 */

async function staged(store: MemoryStateStore) {
	const {state, mutations} = createMutationContext(store);
	return {state, mutations};
}

describe('read-your-writes within the block being processed', () => {
	it('lets a second event in the same block see what the first one wrote', async () => {
		const store = new MemoryStateStore([TOKEN]);
		await store.migrate();
		const {state, mutations} = await staged(store);

		// event 1
		state.set('token', {id: '1'}, {owner: '0xalice', transferCount: 1});
		// event 2, same block: the counter must compose rather than restart
		const seen = await state.get<{transferCount: number}>('token', {id: '1'});
		state.set('token', {id: '1'}, {owner: '0xbob', transferCount: (seen?.transferCount ?? 0) + 1});

		expect(seen?.transferCount).toBe(1);
		// coalesced: one mutation per business key, holding the LAST write
		expect(mutations()).toEqual([
			{type: 'upsert', entity: 'token', id: {id: '1'}, values: {owner: '0xbob', transferCount: 2}},
		]);
	});

	it('falls through to the store for keys this block has not touched', async () => {
		const store = new MemoryStateStore([TOKEN]);
		await store.migrate();
		await store.applyBlock(block(10), [
			{type: 'upsert', entity: 'token', id: {id: '1'}, values: {owner: '0xalice', transferCount: 7}},
		]);

		const {state} = await staged(store);
		expect((await state.get<{transferCount: number}>('token', {id: '1'}))?.transferCount).toBe(7);
	});

	it('reports a key deleted earlier in the block as absent, not as its stored value', async () => {
		const store = new MemoryStateStore([TOKEN]);
		await store.migrate();
		await store.applyBlock(block(10), [
			{type: 'upsert', entity: 'token', id: {id: '1'}, values: {owner: '0xalice', transferCount: 1}},
		]);

		const {state, mutations} = await staged(store);
		state.delete('token', {id: '1'});
		expect(await state.get('token', {id: '1'})).toBeUndefined();
		expect(mutations()).toEqual([{type: 'delete', entity: 'token', id: {id: '1'}}]);
	});

	it('hands back a copy of the staged values, so a handler cannot mutate the staging area', async () => {
		const store = new MemoryStateStore([TOKEN]);
		await store.migrate();
		const {state, mutations} = await staged(store);

		state.set('token', {id: '1'}, {owner: '0xalice', transferCount: 1});
		const read = (await state.get<{transferCount: number}>('token', {id: '1'}))!;
		read.transferCount = 999;

		expect(mutations()).toEqual([
			{type: 'upsert', entity: 'token', id: {id: '1'}, values: {owner: '0xalice', transferCount: 1}},
		]);
	});
});

describe('`set` writes a WHOLE row and `update` is sugar over get-then-spread-then-set', () => {
	it('clears a declared field that `set` does not list', async () => {
		const store = new MemoryStateStore([TOKEN]);
		await store.migrate();
		const {state, mutations} = await staged(store);

		state.set('token', {id: '1'}, {owner: '0xalice', transferCount: 3});
		await store.applyBlock(block(10), mutations());

		const {state: next, mutations: nextMutations} = await staged(store);
		// only `owner` listed: `transferCount` is a declared field of the row being
		// written, and a version is a complete row, so it goes to NULL.
		next.set('token', {id: '1'}, {owner: '0xbob'});
		await store.applyBlock(block(11), nextMutations());

		expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xbob', transferCount: null});
	});

	it('carries an unlisted field through `update`', async () => {
		const store = new MemoryStateStore([TOKEN]);
		await store.migrate();
		const {state, mutations} = await staged(store);

		state.set('token', {id: '1'}, {owner: '0xalice', transferCount: 3});
		await store.applyBlock(block(10), mutations());

		const {state: next, mutations: nextMutations} = await staged(store);
		await next.update('token', {id: '1'}, {owner: '0xbob'});
		await store.applyBlock(block(11), nextMutations());

		expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xbob', transferCount: 3});
	});

	it('is exactly get-then-spread-then-set, so it composes with read-your-writes', async () => {
		const store = new MemoryStateStore([TOKEN]);
		await store.migrate();
		const {state, mutations} = await staged(store);

		state.set('token', {id: '1'}, {owner: '0xalice', transferCount: 1});
		await state.update('token', {id: '1'}, {transferCount: 2});

		expect(mutations()).toEqual([
			{type: 'upsert', entity: 'token', id: {id: '1'}, values: {owner: '0xalice', transferCount: 2}},
		]);
	});

	it('updating a row that does not exist writes just the partial, leaving the rest NULL', async () => {
		const store = new MemoryStateStore([TOKEN]);
		await store.migrate();
		const {state, mutations} = await staged(store);

		await state.update('token', {id: '1'}, {owner: '0xalice'});
		await store.applyBlock(block(10), mutations());

		expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xalice', transferCount: null});
	});

	it("never lets the store's own version columns travel back in as field values", async () => {
		// `get` answers with the row as the store holds it, which on a versioned
		// backend carries `_lower` / `_upper`. `update` spreads that row, so those
		// columns would ride along into `set` if nothing dropped them.
		const store = new MemoryStateStore([TOKEN]);
		await store.migrate();
		const {state, mutations} = await staged(store);
		state.set('token', {id: '1'}, {owner: '0xalice', transferCount: 1});
		await store.applyBlock(block(10), mutations());

		const {state: next, mutations: nextMutations} = await staged(store);
		await next.update('token', {id: '1'}, {transferCount: 2});

		const [mutation] = nextMutations();
		expect(mutation.type).toBe('upsert');
		expect(Object.keys(mutation.type === 'upsert' ? mutation.values : {}).sort()).toEqual(['owner', 'transferCount']);
	});
});

describe('the staging area is per block', () => {
	it('rejects a mutation naming an entity that was never declared', async () => {
		const store = new MemoryStateStore([TOKEN]);
		await store.migrate();
		const {state} = await staged(store);
		expect(() => state.set('ghost', {id: '1'}, {})).toThrow(/ghost/);
		await expect(state.get('ghost', {id: '1'})).rejects.toThrow(/ghost/);
	});

	it('keys the staging area by the business key, whatever order the columns are written in', async () => {
		const store = new MemoryStateStore([{name: 'holding', id: ['account', 'token'], fields: {amount: 'integer'}}]);
		await store.migrate();
		const {state, mutations} = await staged(store);

		state.set('holding', {account: '0xa', token: '1'}, {amount: 1});
		state.set('holding', {token: '1', account: '0xa'}, {amount: 2});

		expect(mutations()).toHaveLength(1);
	});
});
