/**
 * What a store can do, as DATA a caller reads before it asks a question.
 *
 * The alternative is discovering a missing capability from a wrong answer in
 * production, which is the failure this whole seam exists to prevent: an as-of
 * read silently served from the tip is a plausible number that nothing
 * downstream can tell apart from a true one.
 *
 * This module lands the SHAPE. The refusal that gives it teeth (an out-of-window
 * read throwing a typed error of the `NoSuchBlockError` family rather than
 * answering), the deployment setting, and the finality-depth floor all belong to
 * `retention-capability-and-refusal`; the pruning that lets a store honestly
 * claim a window belongs to `prune-versions-outside-retention-window`. Until
 * then a store that keeps everything says so, and none of them may claim a
 * window they do not enforce.
 */

/**
 * How far back superseded versions are kept.
 *
 * The unit is BLOCK NUMBERS, and there is only one unit. Not updates: on the
 * real measured stream event-bearing blocks are median 429 blocks apart, so a
 * 64-block window holds exactly ONE event-bearing block, and reading a window of
 * N blocks as N updates of history is wrong by orders of magnitude on any sparse
 * contract. Not time either: wall-clock pruning would drop history a stalled
 * indexer never finished writing, and would expire the whole window of a halted
 * chain while its tip stands still. Retention keys on the thing that moves the
 * tip.
 */
export type Retention =
	/**
	 * Superseded versions survive only as long as reorg revert needs them, which
	 * is the floor every store pays anyway. Historical reads are not available.
	 */
	| {readonly kind: 'revert-only'}
	/** Superseded versions are kept for `blocks` block numbers behind the tip. */
	| {readonly kind: 'window'; readonly blocks: number}
	/** Nothing is ever pruned: the whole history is readable. */
	| {readonly kind: 'unbounded'};

/** What a store declares about itself, available before `migrate` and before any read. */
export type StateStoreCapabilities = {
	readonly retention: Retention;
	/**
	 * Whether the store answers as-of reads AT ALL.
	 *
	 * Separate from `retention` because they fail differently: a store with a
	 * window answers inside it and refuses outside it, while a store that cannot
	 * reconstruct history refuses everywhere. A `revert-only` store therefore
	 * reports `asOf: false`, and a caller that needs history knows at startup.
	 */
	readonly asOf: boolean;
};
