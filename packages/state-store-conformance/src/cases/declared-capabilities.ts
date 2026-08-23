import {BlockNotRetainedError, retainedRange, type StateStoreCapabilities} from '@etherfold/state-store';
import {expect} from 'vitest';
import {LADDER_BASE, block, cases, opened, owns} from '../fixtures.js';
import type {ConformanceCase, StateStoreFactory} from '../types.js';

const GROUP = 'as-of reads, against what the store CLAIMS';

/**
 * Where the suite meets the capability report: the claim is READ, and then
 * tested.
 *
 * The three claims fail differently, so they are tested differently rather than
 * through one lowest-common-denominator case. A store claiming `unbounded`
 * answers at any depth; a store claiming a WINDOW answers inside it and refuses
 * outside it; a store that answers no historical read refuses everywhere. What
 * none of them may do is answer a historical read from the TIP, because that is
 * a plausible number nothing downstream can tell apart from a true one, and it
 * is the only failure mode here that a user discovers as a wrong balance rather
 * than as an error.
 *
 * The refusal is asserted as `BlockNotRetainedError` and not merely as "it
 * threw": the caller has to be able to tell a retention boundary from a reorg
 * (`NoSuchBlockError`), and both from an entity that was simply absent then
 * (`undefined`). That is ADR-0015's family and ADR-0019's member of it.
 */
export function declaredCapabilityCases(
	factory: StateStoreFactory,
	capabilities: StateStoreCapabilities,
): ConformanceCase[] {
	const retention = capabilities.retention;

	if (!capabilities.asOf || retention.kind === 'revert-only') {
		return cases(GROUP, {
			'claims no historical read, and refuses every one of them': async () => {
				const store = await opened(factory);
				await store.applyBlock(block(LADDER_BASE), [owns('1', '0xalice', 1)]);
				await store.applyBlock(block(LADDER_BASE + 1), [owns('1', '0xbob', 2)]);

				// including a read at its own tip: the claim is about the QUESTION, not
				// about the depth, so there is no block it will answer for.
				await expect(store.getAsOf('token', {id: '1'}, LADDER_BASE + 1)).rejects.toBeInstanceOf(BlockNotRetainedError);
				await expect(store.getAsOf('token', {id: '1'}, LADDER_BASE)).rejects.toBeInstanceOf(BlockNotRetainedError);
			},

			'refuses rather than quietly answering from the tip': async () => {
				const store = await opened(factory);
				await store.applyBlock(block(LADDER_BASE), [owns('1', '0xalice', 1)]);
				await store.applyBlock(block(LADDER_BASE + 1), [owns('1', '0xbob', 2)]);

				const error = await store.getAsOf('token', {id: '1'}, LADDER_BASE).catch((e: unknown) => e);
				expect(error).toBeInstanceOf(BlockNotRetainedError);
				expect((error as BlockNotRetainedError).reason).toBe('no-historical-reads');
				// and the tip is still readable through the read that is honestly about it
				expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xbob'});
			},

			'still reverts, because revert is what it kept the history for': async () => {
				const store = await opened(factory);
				await store.applyBlock(block(LADDER_BASE), [owns('1', '0xalice', 1)]);
				await store.applyBlock(block(LADDER_BASE + 1), [owns('1', '0xbob', 2)]);

				await store.revertTo(LADDER_BASE);
				expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xalice'});
			},
		});
	}

	if (retention.kind === 'unbounded') {
		return cases(GROUP, {
			'claims `unbounded`, so it answers at any depth': async () => {
				const store = await opened(factory);
				await store.applyBlock(block(LADDER_BASE), [owns('1', '0xalice', 1)]);
				await store.applyBlock(block(LADDER_BASE + 1_000_000), [owns('1', '0xbob', 2)]);

				// a million blocks later, the first version is still an answer and not
				// a refusal, which is the whole content of the claim.
				expect(await store.getAsOf('token', {id: '1'}, LADDER_BASE)).toMatchObject({owner: '0xalice'});
				expect(await store.getAsOf('token', {id: '1'}, LADDER_BASE - 1)).toBeUndefined();
			},
		});
	}

	// A window of zero blocks claims no depth to test; it is not a lie, just an
	// empty claim, and `retainedRange` collapses it onto the tip.
	if (retention.kind !== 'window' || retention.blocks < 1) return [];
	// held as its own binding: the narrowing above does not follow `retention`
	// into the closures below, and the window is what every case here is about.
	const claimed = retention;

	/** A first version far below the tip, and a tip the window cannot reach back from. */
	async function windowed() {
		const store = await opened(factory);
		const tip = LADDER_BASE + claimed.blocks + 100;
		await store.applyBlock(block(LADDER_BASE), [owns('1', '0xalice', 1)]);
		await store.applyBlock(block(tip), [owns('1', '0xbob', 2)]);
		const retained = retainedRange(claimed, tip);
		if (!retained) throw new Error('a window claims a retained range; this suite needs it to compute its edges');
		return {store, tip, retained};
	}

	return cases(GROUP, {
		'answers at the oldest block inside the window it claims': async () => {
			const {store, retained} = await windowed();

			// the version live at that block was opened long before it, and a version
			// that is still valid is readable however old it is: a window bounds the
			// BLOCK a caller may ask about, not the age of the answer.
			expect(await store.getAsOf('token', {id: '1'}, retained.from)).toMatchObject({owner: '0xalice'});
		},

		'refuses below the window instead of answering from the tip, naming what was asked and what is kept': async () => {
			const {store, retained} = await windowed();

			const error = await store.getAsOf('token', {id: '1'}, retained.from - 1).catch((e: unknown) => e);
			expect(error).toBeInstanceOf(BlockNotRetainedError);
			expect((error as BlockNotRetainedError).requested).toBe(retained.from - 1);
			expect((error as BlockNotRetainedError).retained).toEqual(retained);
		},

		'refuses at the depth its own claim implies, wherever the claim puts it': async () => {
			const {store} = await windowed();

			// the read that a store claiming MORE would answer: LADDER_BASE is the
			// block the first version opened at, and it is outside every window
			// narrower than the distance to the tip.
			await expect(store.getAsOf('token', {id: '1'}, LADDER_BASE)).rejects.toBeInstanceOf(BlockNotRetainedError);
		},

		'moves the window with the tip': async () => {
			const store = await opened(factory);
			await store.applyBlock(block(LADDER_BASE), [owns('1', '0xalice', 1)]);

			// while the tip is the first block, the window reaches back past it
			expect(await store.getAsOf('token', {id: '1'}, LADDER_BASE)).toMatchObject({owner: '0xalice'});

			await store.applyBlock(block(LADDER_BASE + claimed.blocks + 100), [owns('1', '0xbob', 2)]);

			// the same read, the same block, and now outside: a window is a distance
			// from the tip, so it is the tip moving that takes history away.
			await expect(store.getAsOf('token', {id: '1'}, LADDER_BASE)).rejects.toBeInstanceOf(BlockNotRetainedError);
		},
	});
}
