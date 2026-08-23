import {expect} from 'vitest';
import {LADDER_BASE, block, cases, opened, owns} from '../fixtures.js';
import type {ConformanceCase, StateStoreFactory} from '../types.js';

const GROUP = 'a block is one atomic unit';

/**
 * A block's mutations apply as ONE unit, and a block is applied once.
 *
 * The point is not the transaction; it is what a caller can conclude. If a
 * failed block could leave half of itself behind, then a retry would double some
 * mutations and not others, and nothing downstream could tell which. So the
 * cases assert the caller-visible half: after a failed apply, the state is what
 * it was, and the block NUMBER is free again -- which is how the suite observes
 * "the block was not recorded" without asking a backend for its block table,
 * something the seam deliberately does not expose.
 *
 * The sharp edges are part of the contract rather than an implementation
 * accident. Applying one block twice raises instead of writing a second version,
 * because a caller that re-applies a block has a bug and the store is the only
 * place that can still see it: silently accepting it would leave two versions
 * open for one key, which every read from then on has to pick between.
 */
export function blockAtomicityCases(factory: StateStoreFactory): ConformanceCase[] {
	/** A mutation naming an entity nobody declared: rejected, wherever it sits. */
	const undeclared = {type: 'upsert', entity: 'ghost', id: {id: '1'}, values: {}} as const;

	return cases(GROUP, {
		'a block whose mutations include a rejected one applies NONE of them': async () => {
			const store = await opened(factory);
			await expect(store.applyBlock(block(LADDER_BASE), [owns('1', '0xalice', 1), undeclared])).rejects.toThrow();

			expect(await store.getCurrent('token', {id: '1'})).toBeUndefined();
		},

		'a block that failed to apply was not recorded, so its height is free': async () => {
			const store = await opened(factory);
			await expect(store.applyBlock(block(LADDER_BASE), [owns('1', '0xalice', 1), undeclared])).rejects.toThrow();

			// the same height applies cleanly afterwards: nothing of the failed block
			// survived, not even the block itself.
			await store.applyBlock(block(LADDER_BASE), [owns('1', '0xalice', 1)]);
			expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xalice'});
		},

		'applying the same block twice raises rather than writing a second version': async () => {
			const store = await opened(factory);
			await store.applyBlock(block(LADDER_BASE), [owns('1', '0xalice', 1)]);

			await expect(store.applyBlock(block(LADDER_BASE), [owns('1', '0xbob', 2)])).rejects.toThrow();
			expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xalice', transferCount: 1});
		},

		'a block that carried no mutation is still recorded': async () => {
			const store = await opened(factory);
			await store.applyBlock(block(LADDER_BASE));

			// which blocks exist is the CALLER's judgement: a block carrying a log
			// that changed nothing is still a block a consumer can pin, so the store
			// records every block it is handed and refuses the height afterwards.
			await expect(store.applyBlock(block(LADDER_BASE))).rejects.toThrow();
		},

		'a second hash claiming a height that is already recorded raises': async () => {
			const store = await opened(factory);
			await store.applyBlock(block(LADDER_BASE, '0xaaa'), [owns('1', '0xalice', 1)]);

			// a reorged height must be REVERTED before its replacement is applied;
			// quietly accepting the replacement would leave two truths at one height.
			await expect(store.applyBlock(block(LADDER_BASE, '0xbbb'), [owns('1', '0xbob', 2)])).rejects.toThrow();
		},

		'a mutation naming an entity that was never declared is refused': async () => {
			const store = await opened(factory);
			await expect(store.applyBlock(block(LADDER_BASE), [undeclared])).rejects.toThrow(/ghost/);
		},
	});
}
