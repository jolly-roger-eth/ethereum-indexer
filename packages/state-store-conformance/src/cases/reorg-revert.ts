import type {StateStoreCapabilities} from '@etherfold/state-store';
import {expect} from 'vitest';
import {LADDER_BASE, answersHistoryOverLadder, award, block, burn, cases, opened, owns, pointsOf} from '../fixtures.js';
import type {ConformanceCase, StateStoreFactory} from '../types.js';

const GROUP = 'reorg revert';

/**
 * The load-bearing group, and the reason the suite exists at all.
 *
 * A stored counter that does NOT decrease when its block is reverted is the
 * canonical bug this whole design is meant to make impossible, and it is not
 * hypothetical: `work/notes/findings/sqlite-in-the-browser.md` records the real
 * instance, where reverting the real stream to block 13,364,821 made an
 * accumulated `computedPoints` go from 12 back to 6. That shape is asserted here
 * on EVERY backend rather than once on a shared happy path, because it is
 * exactly the kind of bug a second implementation reintroduces quietly.
 *
 * The counter is accumulated through the mutation context (read, add, write) and
 * not written as a literal, because the read is where the bug bites: the next
 * value is a function of what the store currently reports, so a store that
 * reverts its blocks but not its state keeps handing out points a reorged-out
 * block awarded, and every later block compounds it.
 */
export function reorgRevertCases(factory: StateStoreFactory, capabilities: StateStoreCapabilities): ConformanceCase[] {
	const FORK = LADDER_BASE + 1;

	/** 6 points at block 100, 12 at block 101, and the fork point in between. */
	async function accumulated() {
		const store = await opened(factory);
		await award(store, block(LADDER_BASE), '0xevil', 6);
		await award(store, block(FORK), '0xevil', 6);
		return store;
	}

	return [
		...cases(GROUP, {
			'an accumulated counter goes back DOWN when the block that raised it is reverted': async () => {
				const store = await accumulated();
				expect(await pointsOf(store, '0xevil')).toBe(12);

				await store.revertTo(LADDER_BASE);

				// 6, not 12. The one assertion this suite would be worth writing for.
				expect(await pointsOf(store, '0xevil')).toBe(6);
			},

			'the accumulator resumes from the reverted value when the canonical branch replays': async () => {
				const store = await accumulated();
				await store.revertTo(LADDER_BASE);

				// the canonical block at the same height, awarding 3 rather than 6
				await award(store, block(FORK, '0xcanonical'), '0xevil', 3);

				// 9 = 6 + 3. A store that reverted the versions but left the counter
				// standing would say 15, and nothing downstream could tell.
				expect(await pointsOf(store, '0xevil')).toBe(9);
			},

			'a version the reverted block closed is live again': async () => {
				const store = await opened(factory);
				await store.applyBlock(block(LADDER_BASE), [owns('1', '0xalice', 1)]);
				await store.applyBlock(block(FORK), [owns('1', '0xbob', 2)]);

				await store.revertTo(LADDER_BASE);

				expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xalice', transferCount: 1});
			},

			'an entity first written above the fork is gone': async () => {
				const store = await opened(factory);
				await store.applyBlock(block(LADDER_BASE), [owns('1', '0xalice', 1)]);
				await store.applyBlock(block(FORK), [owns('2', '0xzoe', 1)]);

				await store.revertTo(LADDER_BASE);

				expect(await store.getCurrent('token', {id: '2'})).toBeUndefined();
				expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xalice'});
			},

			'an entity deleted above the fork is back': async () => {
				const store = await opened(factory);
				await store.applyBlock(block(LADDER_BASE), [owns('1', '0xalice', 1)]);
				await store.applyBlock(block(FORK), [burn('1')]);

				await store.revertTo(LADDER_BASE);

				// a delete is only the close of the live version, so undoing it is
				// re-opening that version rather than resurrecting a row from nothing.
				expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xalice'});
			},

			'revert reaches every declared entity, not only the ones the reverted block touched': async () => {
				const store = await opened(factory);
				await store.applyBlock(block(LADDER_BASE), [
					owns('1', '0xalice', 1),
					{type: 'upsert', entity: 'cell', id: {x: 1, y: 2}, values: {owner: '0xalice'}},
				]);
				await store.applyBlock(block(FORK), [
					{type: 'upsert', entity: 'cell', id: {x: 1, y: 2}, values: {owner: '0xbob'}},
				]);

				await store.revertTo(LADDER_BASE);

				expect(await store.getCurrent('cell', {x: 1, y: 2})).toMatchObject({owner: '0xalice'});
			},

			'the same height can be applied again with a different hash once it has been reverted': async () => {
				const store = await accumulated();
				await store.revertTo(LADDER_BASE);

				// what a reorg actually is: the dead branch's block is gone, so the
				// canonical block at that height is a new block and not a duplicate.
				await award(store, block(FORK, '0xcanonical'), '0xevil', 1);
				expect(await pointsOf(store, '0xevil')).toBe(7);
			},

			'reverting above the tip changes nothing': async () => {
				const store = await accumulated();
				await store.revertTo(FORK + 1_000);
				expect(await pointsOf(store, '0xevil')).toBe(12);
			},

			'reverting below every block empties the store and leaves it usable': async () => {
				const store = await accumulated();
				await store.applyBlock(block(FORK + 1), [owns('1', '0xalice', 1)]);

				await store.revertTo(LADDER_BASE - 1);

				expect(await pointsOf(store, '0xevil')).toBeUndefined();
				expect(await store.getCurrent('token', {id: '1'})).toBeUndefined();

				// and the store is not merely empty but WORKING: the blocks are gone
				// too, so the same heights can be indexed again from scratch.
				await award(store, block(LADDER_BASE), '0xevil', 2);
				expect(await pointsOf(store, '0xevil')).toBe(2);
			},
		}),

		...(answersHistoryOverLadder(capabilities)
			? cases(GROUP, {
					'history strictly below the fork is untouched and still readable': async () => {
						const store = await accumulated();
						await store.revertTo(LADDER_BASE);

						expect(await store.getAsOf('player', {address: '0xevil'}, LADDER_BASE)).toMatchObject({
							computedPoints: 6,
						});
						expect(await store.getAsOf('player', {address: '0xevil'}, LADDER_BASE - 1)).toBeUndefined();
					},

					'the reverted block is not readable as of itself afterwards': async () => {
						const store = await accumulated();
						await store.revertTo(LADDER_BASE);

						// the dead branch's version is GONE rather than merely superseded:
						// as of the block it was written in, the state is what survived.
						expect(await store.getAsOf('player', {address: '0xevil'}, FORK)).toMatchObject({computedPoints: 6});
					},
				})
			: []),
	];
}
