import type {RetainedRange} from './retention.js';
import type {Retention} from './capabilities.js';

/**
 * A read about a block this store cannot answer for.
 *
 * The family ADR-0015 opened: "there is no such block" and "that block is known
 * and the entity was absent from it" are different news and must not arrive in
 * the same shape, so the unanswerable case is an ERROR and the absent case is
 * `undefined`. Its members are distinguishable by type and each carries what it
 * needs to say what went wrong:
 *
 * - `NoSuchBlockError` (`@etherfold/state-store-sqlite`): the ADDRESS resolves to
 *   no recorded block, because it was never indexed or has been reorged out.
 * - `BlockNotRetainedError` (here): the block is a perfectly good block, and the
 *   store no longer keeps -- or never keeps -- the versions needed to answer
 *   about it.
 *
 * The base exists so a caller that only wants to know "my historical read did
 * not happen" can catch one thing, while a caller that must distinguish a reorg
 * from a retention boundary still can. It lives at the seam because the second
 * member is thrown by every backend, and two classes of one name in two packages
 * would break `instanceof` across the boundary.
 */
export abstract class BlockUnavailableError extends Error {}

/** Which way a historical read fell outside what the store keeps. */
export type NotRetainedReason =
	/** The store answers as-of reads, but not that far back: it is outside the window. */
	| 'outside-window'
	/** The store answers no as-of read at all (`revert-only`): revert is all it kept history for. */
	| 'no-historical-reads';

/**
 * Thrown by an as-of read the store's declared retention does not cover.
 *
 * It is deliberately NOT the tip value and NOT `undefined`. An as-of read
 * silently served from the tip is a plausible wrong number that nothing
 * downstream can tell apart from a true one, and `undefined` would read as "the
 * entity was absent then", which is an ordinary answer a caller acts on
 * normally. The error says what was ASKED and what is KEPT, so the caller can
 * either widen the retention or stop asking.
 *
 * `retained` is `undefined` exactly when nothing is retained for reading (a
 * `revert-only` store), which is why it is not spelled as an empty range: an
 * empty range would invite arithmetic on a boundary that does not exist.
 */
export class BlockNotRetainedError extends BlockUnavailableError {
	readonly name = 'BlockNotRetainedError';

	constructor(
		/** The block number the read asked about. */
		readonly requested: number,
		/** The block numbers this store can still answer about, or `undefined` if none. */
		readonly retained: RetainedRange | undefined,
		readonly reason: NotRetainedReason,
		readonly retention: Retention,
	) {
		super(
			retained
				? `block ${requested} is outside what this store retains: it keeps blocks ${retained.from} to ` +
						`${retained.to} (a window of ${retained.to - retained.from} blocks behind the tip). The versions needed ` +
						`to answer as of ${requested} are gone, and answering from the tip would be a plausible wrong number ` +
						`rather than an error.`
				: `this store answers no historical read, so state as of block ${requested} is not available: its ` +
						`retention is \`${retention.kind}\`, which keeps superseded versions for reorg revert and nothing else. ` +
						`Read its capabilities at startup rather than discovering this at the call.`,
		);
	}
}
