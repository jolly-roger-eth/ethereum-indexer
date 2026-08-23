/**
 * A revert this store cannot perform, because the reverse patches it would have
 * to replay are gone.
 *
 * **It is deliberately NOT a `BlockUnavailableError`.** That family
 * (`NoSuchBlockError`, `BlockNotRetainedError`) is about a READ this store
 * cannot answer, and every member of it leaves the store exactly as it was and
 * the caller free to carry on with the tip. This is the write path: the host
 * asked for a reorg to be undone and it was not undone, so the state is now
 * KNOWN to be ahead of the canonical chain, and there is nothing to carry on
 * with. Filing it under the read family would invite a `catch` written for a
 * refused history query to swallow it.
 *
 * The alternative was to revert as far as the patches reach and report how far
 * it got. That is rejected on the same ground as answering an as-of read from
 * the tip: a partly-reverted state is a plausible state that nothing downstream
 * can tell apart from a correct one, and it would keep the counter a
 * reorged-out block raised.
 *
 * What a host does with it is re-index the affected range (or re-hydrate from a
 * snapshot). That is a real cost, and it is the cost this backend trades for
 * paying nothing for versioned rows: see the README, and ADR-0023.
 */
export class RevertBeyondPatchHistoryError extends Error {
	readonly name = 'RevertBeyondPatchHistoryError';

	constructor(
		/** The block the caller asked to keep up to. */
		readonly keepUpTo: number,
		/** The recorded blocks above it whose reverse patches are no longer held, ascending. */
		readonly missing: readonly number[],
		/**
		 * The lowest `keepUpTo` this store can still honour, or `undefined` if it
		 * can no longer revert at all.
		 *
		 * Reversals are pruned oldest-first, so what remains is a suffix and this
		 * boundary is a single number rather than a set of holes.
		 */
		readonly deepest: number | undefined,
		/** The declared finality depth the pruning was measured against, if one was declared. */
		readonly finalityDepth: number | undefined,
	) {
		super(
			`cannot revert to block ${keepUpTo}: this store no longer holds the reverse patches for block` +
				`${missing.length === 1 ? '' : 's'} ${missing.join(', ')}, so the reorg cannot be undone. ` +
				(finalityDepth === undefined
					? `No finality depth was declared, so nothing should have been pruned; the patches were dropped elsewhere. `
					: `They were pruned at the declared finality depth of ${finalityDepth} blocks, which is a distance in BLOCK ` +
						`NUMBERS: on a real sparse contract event-bearing blocks are median 429 blocks apart, so a depth of 64 ` +
						`typically keeps exactly one event-bearing block. `) +
				(deepest === undefined
					? `No revert is available. `
					: `The deepest revert still available is to block ${deepest}. `) +
				`Re-index the affected range (or re-hydrate from a snapshot) rather than accept a partly reverted state: ` +
				`this store refuses to reverse only as far as it can, because a half-undone reorg is a plausible wrong ` +
				`state nothing downstream can tell apart from a correct one.`,
		);
	}
}
