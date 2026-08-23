import 'fake-indexeddb/auto';
import {describe, expect, it} from 'vitest';
import type {EntityDeclaration, Mutation} from '@etherfold/state-store';
import {IndexedDBStateStore} from '../src/index.js';
import {freshDatabaseName} from './utils/database.js';
import {boundsOf, cursors, recordAccess} from './utils/access-path.js';

/**
 * What only THIS backend can be asked about the bounded id-prefix listing.
 *
 * The seam gave the listing its exact shape -- a PREFIX of the declared id plus
 * a REQUIRED limit, no predicate, no caller-supplied ordering, no offset -- for
 * one reason: it must be a single indexed range scan on every backend, including
 * the ones with no query planner, because a handler runs it once per event
 * (ADR-0021). On IndexedDB that shape is
 * `IDBKeyRange.bound([prefix], [prefix, []])`, and an implementation that read
 * the whole store and filtered afterwards would answer identically. So the
 * requests are asserted, not the answers.
 */

const PLACEMENT: EntityDeclaration = {
	name: 'placement',
	id: ['epoch', 'position', 'playerIndex'],
	fields: {player: 'text'},
};

function placed(epoch: number, position: number, playerIndex: number, player: string): Mutation {
	return {type: 'upsert', entity: 'placement', id: {epoch, position, playerIndex}, values: {player}};
}

/** One epoch with three children, and 200 rows of other epochs around it. */
async function withCrowdedStore() {
	const store = new IndexedDBStateStore([PLACEMENT], {databaseName: freshDatabaseName()});
	await store.migrate();
	const noise: Mutation[] = [];
	for (let epoch = 10; epoch < 110; epoch++) {
		noise.push(placed(epoch, 0, 0, `0x${epoch}a`), placed(epoch, 1, 0, `0x${epoch}b`));
	}
	await store.applyBlock({number: 100, hash: '0x64', timestamp: 1_700_000_000}, [
		placed(7, 2, 0, '0xcarol'),
		placed(7, 1, 1, '0xbob'),
		placed(7, 1, 0, '0xalice'),
		placed(8, 0, 0, '0xzoe'),
		...noise,
	]);
	return store;
}

describe('the listing is a key range, not a scan with a filter', () => {
	it('opens ONE cursor, over exactly the keys that start with the prefix', async () => {
		const store = await withCrowdedStore();
		const log = recordAccess();
		try {
			await store.listCurrent('placement', {epoch: 7}, 10);
		} finally {
			log.stop();
		}

		expect(cursors(log)).toHaveLength(1);
		expect(cursors(log)[0].on).toBe('current');
		// `[]` sorts after every string, so the upper bound is unreachable by any
		// real key and the range IS "the prefix and its descendants".
		expect(boundsOf(cursors(log)[0].query)).toEqual({
			lower: ['placement', '7'],
			upper: ['placement', '7', []],
			lowerOpen: false,
			upperOpen: false,
		});
		// nothing else was read: no `getAll`, no second lookup per row
		expect(log.requests.filter((request) => request.method !== 'openCursor')).toEqual([]);
	});

	it('narrows the range as the prefix lengthens, down to the whole id', async () => {
		const store = await withCrowdedStore();
		const log = recordAccess();
		try {
			await store.listCurrent('placement', {epoch: 7, position: 1}, 10);
		} finally {
			log.stop();
		}

		expect(boundsOf(cursors(log)[0].query).lower).toEqual(['placement', '7', '1']);
		expect(boundsOf(cursors(log)[0].query).upper).toEqual(['placement', '7', '1', []]);
	});

	it('walks the children of the prefix and NOT the 200 rows around them', async () => {
		const store = await withCrowdedStore();
		const log = recordAccess();
		try {
			const listing = await store.listCurrent('placement', {epoch: 7}, 10);
			expect(listing.rows).toHaveLength(3);
		} finally {
			log.stop();
		}

		// three children, and one more `continue` that lands past the range. A scan
		// with a filter over it would be 204.
		expect(log.recordsVisited).toBe(3);
	});

	it('stops at the limit plus one, so `truncated` costs one record and not the rest', async () => {
		const store = await withCrowdedStore();
		const log = recordAccess();
		try {
			const listing = await store.listCurrent('placement', {epoch: 7}, 2);
			expect(listing.truncated).toBe(true);
		} finally {
			log.stop();
		}

		// two rows answered, one read to know there was a third, and then stop:
		// `truncated` is a fact rather than an inference from `rows.length`.
		expect(log.recordsVisited).toBe(2);
	});

	it('reads the historical listing off the versions, in the same range shape', async () => {
		const store = await withCrowdedStore();
		const log = recordAccess();
		try {
			await store.listAsOf('placement', {epoch: 7}, 100, 10);
		} finally {
			log.stop();
		}

		expect(cursors(log)).toHaveLength(1);
		expect(cursors(log)[0].on).toBe('versions');
		expect(boundsOf(cursors(log)[0].query)).toEqual({
			lower: ['placement', '7'],
			upper: ['placement', '7', []],
			lowerOpen: false,
			upperOpen: false,
		});
	});
});

describe('the point reads are bounded too', () => {
	it('answers a tip read with one `get` against the live set', async () => {
		const store = await withCrowdedStore();
		const log = recordAccess();
		try {
			await store.getCurrent('placement', {epoch: 7, position: 1, playerIndex: 0});
		} finally {
			log.stop();
		}

		expect(log.requests).toEqual([{method: 'get', on: 'current', query: ['placement', '7', '1', '0']}]);
	});

	it('answers an as-of read with one backwards cursor over that key`s versions', async () => {
		const store = await withCrowdedStore();
		const log = recordAccess();
		try {
			await store.getAsOf('placement', {epoch: 7, position: 1, playerIndex: 0}, 100);
		} finally {
			log.stop();
		}

		// bounded ABOVE by the block asked about, so the first hit walking backwards
		// is the newest version that had opened by then: no version older than the
		// answer is ever read.
		expect(cursors(log)).toHaveLength(1);
		expect(boundsOf(cursors(log)[0].query)).toEqual({
			lower: ['placement', '7', '1', '0'],
			upper: ['placement', '7', '1', '0', 100],
			lowerOpen: false,
			upperOpen: false,
		});
		expect(log.recordsVisited).toBe(0);
	});
});
