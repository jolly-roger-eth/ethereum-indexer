import {createMutationContext, type StateStoreCapabilities} from '@etherfold/state-store';
import {expect} from 'vitest';
import {
	LADDER_BASE,
	answersHistoryOverLadder,
	block,
	cases,
	declaredColumns,
	opened,
	owns,
	placed,
	playersOf,
	pointsOf,
} from '../fixtures.js';
import type {ConformanceCase, StateStoreFactory} from '../types.js';

const GROUP = 'read-your-writes within a block';

/**
 * Two events in one block that touch one counter must compose.
 *
 * The staging area is implemented ONCE, above the backend interface, so a
 * backend cannot get this subtly wrong by implementing it differently -- but it
 * can get it wrong by answering the fall-through read wrongly, or by writing the
 * staged version in a way that leaves the block's own result unreadable. So the
 * cases are here, run against every backend, rather than left as a unit test of
 * the staging area.
 *
 * It is load-bearing rather than theoretical: on the real stratagems stream,
 * 16,871 of 66,113 reads were served from the block's own staging area.
 */
export function readYourWritesCases(
	factory: StateStoreFactory,
	capabilities: StateStoreCapabilities,
): ConformanceCase[] {
	return [
		...cases(GROUP, {
			'a second event in the same block sees what the first wrote': async () => {
				const store = await opened(factory);
				const {state, mutations} = createMutationContext(store);

				const first = await state.get<{computedPoints: number}>('player', {address: '0xevil'});
				state.set('player', {address: '0xevil'}, {computedPoints: (first?.computedPoints ?? 0) + 6});
				const second = await state.get<{computedPoints: number}>('player', {address: '0xevil'});
				state.set('player', {address: '0xevil'}, {computedPoints: (second?.computedPoints ?? 0) + 6});

				await store.applyBlock(block(LADDER_BASE), mutations());

				// 12: the second handler read the first handler's write, inside the
				// block, before anything was applied.
				expect(await pointsOf(store, '0xevil')).toBe(12);
			},

			'a row written earlier in this block reads back WHOLE, exactly as one written earlier': async () => {
				// The shape of a row must not depend on WHEN it was written. `id` is an
				// id column and `transferCount` is a declared field this write does not
				// list, so both belong to the row the store will hold, and a handler
				// that reads its own block's write must not get a partial one: a field
				// that is only sometimes there comes back as `undefined`, which is a
				// legal value meaning "not set" rather than an error anyone notices.
				const store = await opened(factory);
				const {state, mutations} = createMutationContext(store);
				state.set('token', {id: '1'}, {owner: '0xalice'});

				const sameBlock = await state.get<Record<string, unknown>>('token', {id: '1'});
				expect(sameBlock).toMatchObject({id: '1', owner: '0xalice', transferCount: null});

				await store.applyBlock(block(LADDER_BASE), mutations());
				const laterBlock = await createMutationContext(store).state.get<Record<string, unknown>>('token', {id: '1'});

				// the same declared columns on both sides of the block boundary (the
				// version columns are the one difference a staged row cannot hide: it
				// has no version yet)
				expect(declaredColumns(sameBlock)).toEqual(declaredColumns(laterBlock));
				expect(declaredColumns(laterBlock)).toEqual(['id', 'owner', 'transferCount']);
			},

			'`get` and `list` agree about a row this block staged': async () => {
				const store = await opened(factory);
				const {state} = createMutationContext(store);
				state.set('placement', {epoch: 7, position: 1, playerIndex: 0}, {player: '0xalice'});

				const listed = (await state.list<Record<string, unknown>>('placement', {epoch: 7}, 10)).rows[0];
				expect(await state.get('placement', {epoch: 7, position: 1, playerIndex: 0})).toEqual(listed);
			},

			'a read for a key this block has not touched falls through to the store': async () => {
				const store = await opened(factory);
				await store.applyBlock(block(LADDER_BASE), [owns('1', '0xalice', 1)]);

				const {state} = createMutationContext(store);
				state.set('token', {id: '2'}, {owner: '0xzoe', transferCount: 1});

				expect(await state.get('token', {id: '1'})).toMatchObject({owner: '0xalice'});
			},

			'a delete staged after a write in one block leaves the entity absent': async () => {
				const store = await opened(factory);
				const {state, mutations} = createMutationContext(store);
				state.set('token', {id: '1'}, {owner: '0xalice', transferCount: 1});
				state.delete('token', {id: '1'});

				expect(await state.get('token', {id: '1'})).toBeUndefined();

				await store.applyBlock(block(LADDER_BASE), mutations());
				expect(await store.getCurrent('token', {id: '1'})).toBeUndefined();
			},

			'`update` carries a declared field the write does not mention, and `set` clears it': async () => {
				// The version columns are the trap here, not the sugar: `get` answers
				// with the row as the store holds it, which on a versioned backend
				// carries the range columns, and `update` spreads what `get` returned.
				// A backend whose read shape leaked into the write would show up here.
				const store = await opened(factory);
				await store.applyBlock(block(LADDER_BASE), [owns('1', '0xalice', 3)]);

				const updated = createMutationContext(store);
				await updated.state.update('token', {id: '1'}, {owner: '0xbob'});
				await store.applyBlock(block(LADDER_BASE + 1), updated.mutations());
				expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xbob', transferCount: 3});

				const replaced = createMutationContext(store);
				replaced.state.set('token', {id: '1'}, {owner: '0xcarol'});
				await store.applyBlock(block(LADDER_BASE + 2), replaced.mutations());
				expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xcarol', transferCount: null});
			},

			'a LISTING made later in the block sees exactly what the block has done to it': async () => {
				// The part of read-your-writes a listing cannot get for free: a child
				// written earlier in the block is not in the store yet, and one deleted
				// earlier in the block still is, so the staging area has to be merged
				// into the range scan rather than fallen back on.
				const store = await opened(factory);
				await store.applyBlock(block(LADDER_BASE), [placed(7, 1, 0, '0xalice'), placed(7, 2, 0, '0xcarol')]);

				const {state, mutations} = createMutationContext(store);
				// one event of the block writes two children and deletes a third
				state.set('placement', {epoch: 7, position: 3, playerIndex: 0}, {player: '0xdan'});
				state.set('placement', {epoch: 7, position: 0, playerIndex: 0}, {player: '0xerin'});
				state.delete('placement', {epoch: 7, position: 1, playerIndex: 0});

				// a later event of the SAME block lists the prefix
				const listing = await state.list<Record<string, unknown>>('placement', {epoch: 7}, 10);
				expect(playersOf(listing.rows)).toEqual(['0xerin', '0xcarol', '0xdan']);

				// and the store agrees once the block lands
				await store.applyBlock(block(LADDER_BASE + 1), mutations());
				const applied = await store.listCurrent<Record<string, unknown>>('placement', {epoch: 7}, 10);
				expect(playersOf(applied.rows)).toEqual(['0xerin', '0xcarol', '0xdan']);
			},

			"fills a listing's limit from beyond the children this block deleted": async () => {
				// Asking the store for exactly `limit` rows would come back short here,
				// because a row this block deleted takes a slot in the store's answer
				// and none in the caller's.
				const store = await opened(factory);
				await store.applyBlock(block(LADDER_BASE), [
					placed(7, 1, 0, '0xalice'),
					placed(7, 2, 0, '0xbob'),
					placed(7, 3, 0, '0xcarol'),
				]);

				const {state} = createMutationContext(store);
				state.delete('placement', {epoch: 7, position: 1, playerIndex: 0});

				const listing = await state.list<Record<string, unknown>>('placement', {epoch: 7}, 2);
				expect(playersOf(listing.rows)).toEqual(['0xbob', '0xcarol']);
				expect(listing.truncated).toBe(false);
			},

			'`update` on an entity that does not exist yet writes the fields it was given': async () => {
				const store = await opened(factory);
				const {state, mutations} = createMutationContext(store);
				await state.update('token', {id: '1'}, {owner: '0xalice'});
				await store.applyBlock(block(LADDER_BASE), mutations());

				expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xalice', transferCount: null});
			},
		}),

		...(answersHistoryOverLadder(capabilities)
			? cases(GROUP, {
					'a key written twice in one block leaves ONE state as of that block': async () => {
						const store = await opened(factory);
						await store.applyBlock(block(LADDER_BASE), [owns('1', '0xalice', 1)]);

						const {state, mutations} = createMutationContext(store);
						state.set('token', {id: '1'}, {owner: '0xbob', transferCount: 2});
						state.set('token', {id: '1'}, {owner: '0xcarol', transferCount: 3});
						await store.applyBlock(block(LADDER_BASE + 1), mutations());

						// as of the block, the LAST write, with nothing in between that an
						// as-of read could land on; as of the block before, the old value.
						expect(await store.getAsOf('token', {id: '1'}, LADDER_BASE + 1)).toMatchObject({owner: '0xcarol'});
						expect(await store.getAsOf('token', {id: '1'}, LADDER_BASE)).toMatchObject({owner: '0xalice'});
					},
				})
			: []),
	];
}
