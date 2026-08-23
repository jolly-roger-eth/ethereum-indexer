import 'fake-indexeddb/auto';
import {describe, expect, it} from 'vitest';
import type {EntityDeclaration, Mutation} from '@etherfold/state-store';
import {IndexedDBStateStore} from '../src/index.js';
import {freshDatabaseName} from './utils/database.js';
import {cursors, recordAccess} from './utils/access-path.js';

/**
 * What only THIS backend can be asked about reverting.
 *
 * That a revert restores the state as of the fork -- including the accumulated
 * counter that has to go back DOWN -- is the seam's contract, asserted for every
 * backend by the shared suite. What is asserted here is the ACCESS PATH and the
 * absence of a journal: the versions above the fork are found through the two
 * indexes (`lower` for what the dead branch opened, `upper` for what it closed),
 * so a revert costs what it touches rather than what the store holds, and there
 * is no per-block undo log growing with every mutation ever applied.
 */

const TOKEN: EntityDeclaration = {name: 'token', id: ['id'], fields: {owner: 'text'}};

function owns(id: string, owner: string): Mutation {
	return {type: 'upsert', entity: 'token', id: {id}, values: {owner}};
}

function block(number: number) {
	return {number, hash: `0x${number.toString(16)}`, timestamp: 1_700_000_000 + number * 12};
}

/** 200 rows written long ago, and two blocks above the fork point. */
async function withDeepHistory() {
	const store = new IndexedDBStateStore([TOKEN], {databaseName: freshDatabaseName()});
	await store.migrate();
	const old: Mutation[] = [];
	for (let index = 0; index < 200; index++) old.push(owns(`old-${index}`, '0xancient'));
	await store.applyBlock(block(100), old);
	await store.applyBlock(block(101), [owns('old-0', '0xreplaced'), owns('new', '0xfresh')]);
	return store;
}

describe('a revert is two index range scans', () => {
	it('walks only the versions above the fork, not the store', async () => {
		const store = await withDeepHistory();
		const log = recordAccess();
		try {
			await store.revertTo(100);
		} finally {
			log.stop();
		}

		expect(cursors(log).map((request) => request.on)).toEqual(['lower', 'upper']);
		// leg A: the two versions block 101 opened. leg B: the one it closed.
		// 200 untouched rows are not read at all.
		expect(log.recordsVisited).toBe(3);
	});

	it('puts back what the dead branch closed, and removes what it opened', async () => {
		const store = await withDeepHistory();

		await store.revertTo(100);

		expect(await store.getCurrent('token', {id: 'old-0'})).toMatchObject({owner: '0xancient'});
		expect(await store.getCurrent('token', {id: 'new'})).toBeUndefined();
		// the live set is fixed as the legs go, so the listing agrees with the point
		// read rather than serving a stale copy of the dead branch
		expect((await store.listCurrent('token', {id: 'new'}, 10)).rows).toEqual([]);
		// and the height is free again, so the canonical block can be applied
		await store.applyBlock(block(101), [owns('new', '0xcanonical')]);
		expect(await store.getCurrent('token', {id: 'new'})).toMatchObject({owner: '0xcanonical'});
	});

	it('empties the store when it is reverted below every block, which is what a reset is', async () => {
		// `revertTo(-1)` is how a processor wipes state it can no longer trust (a
		// changed version hash, a rebuild): every version has a lower bound of at
		// least 0, so "drop everything opened above -1" is "drop everything", and
		// the same call clears the block records.
		const store = await withDeepHistory();

		await store.revertTo(-1);

		expect(await store.getCurrent('token', {id: 'old-1'})).toBeUndefined();
		expect(await store.getBlock(100)).toBeUndefined();
		expect((await store.listCurrent('token', {id: 'old-1'}, 10)).rows).toEqual([]);

		// and it is a store, not a ruin: the same heights apply cleanly afterwards
		await store.applyBlock(block(100), [owns('old-1', '0xreindexed')]);
		expect(await store.getCurrent('token', {id: 'old-1'})).toMatchObject({owner: '0xreindexed'});
		expect(await store.getAsOf('token', {id: 'old-1'}, 100)).toMatchObject({owner: '0xreindexed'});
	});
});
