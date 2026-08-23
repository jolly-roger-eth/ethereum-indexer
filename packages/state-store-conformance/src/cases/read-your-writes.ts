import {createMutationContext, type StateStoreCapabilities} from '@etherfold/state-store';
import {expect} from 'vitest';
import {LADDER_BASE, answersHistoryOverLadder, block, cases, opened, owns, pointsOf} from '../fixtures.js';
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
