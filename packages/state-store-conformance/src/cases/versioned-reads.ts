import type {StateStoreCapabilities} from '@etherfold/state-store';
import {expect} from 'vitest';
import {LADDER_BASE, answersHistoryOverLadder, block, burn, cases, opened, owns} from '../fixtures.js';
import type {ConformanceCase, StateStoreFactory} from '../types.js';

const GROUP = 'versioned reads';

/**
 * A version is a COMPLETE row with a half-open block-validity range, and this
 * group is that sentence turned into questions a caller can ask.
 *
 * Nothing here looks at a table, a statement or a version column: every
 * assertion is what a read returns after a write, so a patch-log backend and a
 * versioned-rows backend can both be asked it. The half-open range shows up as
 * behaviour rather than as columns -- a version is live AT the block that opened
 * it and NOT at the block that closed it -- which is the only form of it a
 * backend that stores no ranges could still honour.
 */
export function versionedReadCases(
	factory: StateStoreFactory,
	capabilities: StateStoreCapabilities,
): ConformanceCase[] {
	/** [100) alice  [101) bob  [102) carol  [103) burned. */
	async function ladder() {
		const store = await opened(factory);
		await store.applyBlock(block(LADDER_BASE), [owns('1', '0xalice', 1)]);
		await store.applyBlock(block(LADDER_BASE + 1), [owns('1', '0xbob', 2)]);
		await store.applyBlock(block(LADDER_BASE + 2), [owns('1', '0xcarol', 3)]);
		return store;
	}

	return [
		...cases(GROUP, {
			'a write is readable at the tip': async () => {
				const store = await ladder();
				expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xcarol', transferCount: 3});
			},

			'an entity that was never written reads as undefined, not as an error': async () => {
				const store = await opened(factory);
				expect(await store.getCurrent('token', {id: 'never'})).toBeUndefined();
			},

			'a delete makes the entity absent at the tip': async () => {
				const store = await ladder();
				await store.applyBlock(block(LADDER_BASE + 3), [burn('1')]);
				expect(await store.getCurrent('token', {id: '1'})).toBeUndefined();
			},

			'a declared field the write does not list becomes NULL, because a version is a WHOLE row': async () => {
				const store = await ladder();
				await store.applyBlock(block(LADDER_BASE + 3), [
					{type: 'upsert', entity: 'token', id: {id: '1'}, values: {owner: '0xdan'}},
				]);
				// not 3, and not missing: the new version is complete, and the field it
				// left out is empty in it. A store that carried the old value forward
				// would be storing deltas while claiming to store versions.
				expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xdan', transferCount: null});
			},

			'a business key is one entity however it was spelled': async () => {
				const store = await opened(factory);
				await store.applyBlock(block(LADDER_BASE), [
					{type: 'upsert', entity: 'token', id: {id: 1}, values: {owner: '0xalice', transferCount: 1}},
				]);
				expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xalice'});
			},

			'a composite business key names one entity, and its column order does not matter': async () => {
				const store = await opened(factory);
				await store.applyBlock(block(LADDER_BASE), [
					{type: 'upsert', entity: 'cell', id: {x: 1, y: 2}, values: {owner: '0xalice'}},
					{type: 'upsert', entity: 'cell', id: {x: 2, y: 1}, values: {owner: '0xbob'}},
				]);

				expect(await store.getCurrent('cell', {y: 2, x: 1})).toMatchObject({owner: '0xalice'});
				expect(await store.getCurrent('cell', {y: 1, x: 2})).toMatchObject({owner: '0xbob'});
			},
		}),

		...(answersHistoryOverLadder(capabilities)
			? cases(GROUP, {
					'each version is readable as of the blocks it was live for': async () => {
						const store = await ladder();
						expect(await store.getAsOf('token', {id: '1'}, LADDER_BASE)).toMatchObject({owner: '0xalice'});
						expect(await store.getAsOf('token', {id: '1'}, LADDER_BASE + 1)).toMatchObject({owner: '0xbob'});
						expect(await store.getAsOf('token', {id: '1'}, LADDER_BASE + 2)).toMatchObject({owner: '0xcarol'});
					},

					'a version is live AT the block that opened it and not at the block that closed it': async () => {
						// the half-open range, as behaviour rather than as columns
						const store = await ladder();
						expect(await store.getAsOf('token', {id: '1'}, LADDER_BASE + 1)).toMatchObject({owner: '0xbob'});
						expect(await store.getAsOf('token', {id: '1'}, LADDER_BASE + 2)).not.toMatchObject({owner: '0xbob'});
					},

					'an as-of read at or after the last change is the value that is still live': async () => {
						const store = await ladder();
						expect(await store.getAsOf('token', {id: '1'}, LADDER_BASE + 5)).toMatchObject({owner: '0xcarol'});
					},

					'an entity is absent as of any block before its first version': async () => {
						const store = await ladder();
						expect(await store.getAsOf('token', {id: '1'}, LADDER_BASE - 1)).toBeUndefined();
					},

					'a deleted entity is absent from its delete block onward and fully readable as of any earlier block':
						async () => {
							const store = await ladder();
							await store.applyBlock(block(LADDER_BASE + 3), [burn('1')]);

							expect(await store.getAsOf('token', {id: '1'}, LADDER_BASE + 3)).toBeUndefined();
							expect(await store.getAsOf('token', {id: '1'}, LADDER_BASE + 4)).toBeUndefined();
							expect(await store.getAsOf('token', {id: '1'}, LADDER_BASE + 2)).toMatchObject({owner: '0xcarol'});
							expect(await store.getAsOf('token', {id: '1'}, LADDER_BASE)).toMatchObject({owner: '0xalice'});
						},

					'a value written and then superseded is not the value an as-of read returns': async () => {
						// the failure this group exists for: a store that answers every
						// historical read from the tip passes every case above and this one
						// alone catches it.
						const store = await ladder();
						const current = await store.getCurrent<{owner: string}>('token', {id: '1'});
						const historical = await store.getAsOf<{owner: string}>('token', {id: '1'}, LADDER_BASE);

						expect(current?.owner).toBe('0xcarol');
						expect(historical?.owner).toBe('0xalice');
					},
				})
			: []),
	];
}
