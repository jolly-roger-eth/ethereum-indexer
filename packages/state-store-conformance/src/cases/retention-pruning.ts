import {BlockNotRetainedError, type StateStoreCapabilities} from '@etherfold/state-store';
import {expect} from 'vitest';
import {LADDER_BASE, award, block, cases, opened, owns, pointsOf} from '../fixtures.js';
import type {ConformanceCase, StateStoreFactory} from '../types.js';

const GROUP = 'pruning, and what must survive it';

/**
 * What a backend may delete, and what it may never delete.
 *
 * Pruning is the second half of retention: the window bounds what a read may ASK
 * about (`declared-capabilities.ts`), and pruning bounds what the store HOLDS.
 * Only the second half can lose data, which is why the cases here are written as
 * survival properties rather than as "it deleted something": what a prune
 * removed is a backend's own business (a row count in SQLite, a map entry in
 * memory, and the shared suite asserts on neither), while what a prune must
 * NEVER remove is the same on every substrate.
 *
 * The dangerous one is first and it is not an edge case. The LIVE version of an
 * entity is the current state however old it is, and on the real measured stream
 * (`work/notes/findings/sqlite-in-the-browser.md`) event-bearing blocks are
 * median 429 apart and the state contains rows written once and never revisited.
 * A prune expressed as "delete what is older than the floor" passes every test
 * about deleting and destroys the state.
 *
 * `prune` is asked of EVERY backend, including the ones with nothing to prune,
 * because "keep everything" is a legitimate answer to "drop what is unreachable"
 * and a host that prunes on a schedule must not have to ask what it is holding
 * first.
 */
export function retentionPruningCases(
	factory: StateStoreFactory,
	capabilities: StateStoreCapabilities,
): ConformanceCase[] {
	const retention = capabilities.retention;

	const universal = cases(GROUP, {
		'keeps the LIVE version of an entity untouched since long before any floor': async () => {
			const store = await opened(factory);
			await store.applyBlock(block(LADDER_BASE), [owns('1', '0xalice', 1)]);
			// a million blocks later, and token 1 was never written again: it is still
			// the current state, and no retention setting makes it droppable.
			await store.applyBlock(block(LADDER_BASE + 1_000_000), [owns('2', '0xbob', 1)]);

			await store.prune();

			expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xalice'});
		},

		'is a no-op before the first block, when there is no tip to measure a floor from': async () => {
			const store = await opened(factory);
			const report = await store.prune();

			expect(report.versionsDeleted).toBe(0);
			expect(report.complete).toBe(true);
		},

		'still reverts afterwards, with an accumulated counter going back DOWN': async () => {
			const store = await opened(factory);
			await award(store, block(LADDER_BASE), '0xplayer', 6);
			await award(store, block(LADDER_BASE + 1), '0xplayer', 6);

			await store.prune();
			await store.revertTo(LADDER_BASE);

			// the canonical reorg bug, asked again on the far side of a prune: a store
			// that pruned the version revert has to reopen leaves the counter at 12.
			expect(await pointsOf(store, '0xplayer')).toBe(6);
		},

		'refuses a budget that is not a whole number of versions': async () => {
			const store = await opened(factory);
			await expect(store.prune({maxVersions: 0})).rejects.toThrow(/versions/i);
		},
	});

	if (retention.kind === 'unbounded') {
		return [
			...universal,
			...cases(GROUP, {
				'drops nothing, because `unbounded` is the claim that nothing is ever unreachable': async () => {
					const store = await opened(factory);
					await store.applyBlock(block(LADDER_BASE), [owns('1', '0xalice', 1)]);
					await store.applyBlock(block(LADDER_BASE + 1_000_000), [owns('1', '0xbob', 2)]);

					const report = await store.prune();

					expect(report.versionsDeleted).toBe(0);
					expect(report.floor).toBeUndefined();
					// and the history the claim promises is still there afterwards
					expect(await store.getAsOf('token', {id: '1'}, LADDER_BASE)).toMatchObject({owner: '0xalice'});
				},
			}),
		];
	}

	// A window of one block has no inside to read at: `closing` below would have to
	// sit both above the floor and below the tip, and there is no room.
	if (retention.kind !== 'window' || retention.blocks < 2) return universal;
	const claimed = retention;

	/**
	 * A store pruned at a floor deep inside its own history, with one version
	 * closed just INSIDE the window and one opened long before it.
	 *
	 * The arithmetic is the point: `closing` is the version boundary the window
	 * only just covers, so a prune off by one in either direction is visible.
	 */
	async function prunedAtTheEdge() {
		const store = await opened(factory);
		const tip = LADDER_BASE + claimed.blocks + 1_000;
		const floor = tip - claimed.blocks;
		await store.applyBlock(block(LADDER_BASE), [owns('1', '0xalice', 1)]);
		await store.applyBlock(block(floor + 1), [owns('1', '0xbob', 2)]);
		await store.applyBlock(block(tip), [owns('2', '0xother', 1)]);
		await store.prune();
		return {store, tip, floor};
	}

	return [
		...universal,
		...cases(GROUP, {
			'still answers at the oldest block inside the window': async () => {
				const {store, floor} = await prunedAtTheEdge();

				// Alice's version is valid over [LADDER_BASE, floor + 1), so it is still
				// the answer AT the floor. Pruning it would turn a promise into a hole.
				expect(await store.getAsOf('token', {id: '1'}, floor)).toMatchObject({owner: '0xalice'});
			},

			'still refuses below the window, rather than answering from the tip': async () => {
				const {store, floor} = await prunedAtTheEdge();

				const error = await store.getAsOf('token', {id: '1'}, floor - 1).catch((e: unknown) => e);
				// the refusal is the same one it gave before the prune: what changed is
				// the bytes, not the contract.
				expect(error).toBeInstanceOf(BlockNotRetainedError);
			},

			'keeps the live version of a row written far below the floor': async () => {
				const {store} = await prunedAtTheEdge();
				expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xbob'});
			},

			'reverts to the FULL depth of its window afterwards, because that is the reorg floor': async () => {
				const {store, floor} = await prunedAtTheEdge();

				// A window may not go below the finality depth, so a reorg reaching the
				// bottom of the window is the deepest one this store promises to undo.
				// Everything it needs to undo it must have survived the prune.
				await store.revertTo(floor);

				expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xalice'});
				expect(await store.getCurrent('token', {id: '2'})).toBeUndefined();
			},
		}),
	];
}
