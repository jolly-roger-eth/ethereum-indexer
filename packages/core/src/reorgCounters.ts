import type {ReorgCause, ReorgDetection} from './internal/engine/utils.js';

/**
 * A concluded reorg, as it is REMEMBERED rather than as it was derived: the
 * detection plus when it was written down.
 */
export type RecordedReorg = ReorgDetection & {at: string};

/**
 * How many reverts of each kind a database has recorded, and the last one.
 *
 * The split is the whole point. A `contradiction` is proof (the same height now
 * carries a different hash) and is ordinary chain activity. An `absence` is an
 * INFERENCE: a block we held is simply not in the re-delivered range, which is
 * indistinguishable from a sender that under-delivered it. Both revert state, so
 * folding them into one number would hide the only signal that says "your logs
 * are being truncated" rather than "the chain reorged" (ADR-0004).
 */
export type ReorgCounters = {
	absence: number;
	contradiction: number;
	last?: RecordedReorg;
};

/**
 * The DURABLE NAMES the counts are kept under, which live here because the
 * writer and the reader are deliberately in different packages.
 *
 * A reorg is concluded by the fold, so whoever OWNS the store writes the count
 * (ADR-0050); the process that READS it back may own no store at all -- a read
 * tier is a database connection and an HTTP surface and nothing else. Two
 * packages therefore have to agree on one key, and the only package both of them
 * already depend on is the one that decides what a `ReorgCause` IS. Spelling the
 * strings twice is how the two silently stop describing the same database.
 *
 * They are opaque keys, not a schema: WHERE they are stored (today a `_meta`
 * row per key in the libSQL artifact) is the store owner's business, and nothing
 * here knows about SQL.
 */
export const REORG_COUNTER_KEY: Readonly<Record<ReorgCause, string>> = {
	absence: 'reorgs.absence',
	contradiction: 'reorgs.contradiction',
};

/** The key the most recent `RecordedReorg` is kept under, as JSON. */
export const REORG_LAST_KEY = 'reorgs.last';

/**
 * Where a concluded reorg is COUNTED, injected into the receiver by whoever owns
 * the store.
 *
 * The count is a fact about the FOLD and not about the transport, so it cannot
 * belong to an HTTP route: a combined process folds through
 * `createDirectIngestion` and touches no route at all, and used to report
 * `{absence: 0, contradiction: 0}` for ever as a result. It cannot belong to
 * this package either, which stores nothing and knows no database. So the
 * receiver REPORTS the reorg to one collaborator, exactly once per concluded
 * revert, and the deployment that opened the database supplies it (ADR-0050).
 *
 * A recorder may fail and must never be allowed to matter: `StreamBuilder`
 * catches and logs, because the state and the cursor already moved atomically
 * and an operational counter that could roll back the state it describes would
 * be a far worse trade. Absent entirely on a host that has nowhere to write, in
 * which case nothing is counted and nothing breaks.
 */
export type ReorgRecorder = (reorg: ReorgDetection) => void | Promise<void>;
