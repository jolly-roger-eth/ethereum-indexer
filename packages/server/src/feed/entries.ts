// ---------------------------------------------------------------------------------------------------
// ONE ROW OF THE STORED EMISSION STREAM, AND THE TWO SHAPES THE TWO VIEWS HAND IT BACK IN
// ---------------------------------------------------------------------------------------------------
// Shared by both of ADR-0006's views, because the difference between them is a
// VERDICT and not a log: the retraction-aware feed adds `removed`, the canonical
// view has nothing to add because it never serves a retraction at all. Two
// copies of the column list and the topic re-gathering would be two places for
// the stored shape and the served shape to drift apart.
// ---------------------------------------------------------------------------------------------------

/** Every column the two views read, in the shape SQLite hands one back. */
export type EmissionRow = {
	seq: number;
	removed: number;
	blockNumber: number;
	blockHash: string;
	logIndex: number;
	transactionHash: string;
	transactionIndex: number;
	blockTimestamp: number | null;
	address: string;
	topic0: string | null;
	topic1: string | null;
	topic2: string | null;
	topic3: string | null;
	data: string;
};

/**
 * ONE entry as the CANONICAL view hands it back: the raw log the node reported,
 * and nothing else.
 *
 * The same shape as `EmittedLog` in `@etherfold/core` (a `NumberifiedLog`), so
 * what goes in the table and what comes out of a feed are one vocabulary, minus
 * the `0x`-branded types: a row read back out of SQLite carries no proof of its
 * own shape, and claiming one would be a cast pretending to be a check.
 *
 * There is deliberately NO `seq` on it. The position is the CURSOR's business --
 * publishing it is how a consumer ends up incrementing it, which holes make
 * wrong -- and no `alive` either, which is the flag the canonical read already
 * applied on the consumer's behalf.
 *
 * And no `removed`, which is the whole point of this shape existing separately.
 * A flag that is false on every entry a view can ever serve is an invitation to
 * write `if (entry.removed)` handling that can never fire, which is exactly the
 * reorg handling the canonical view exists to remove from a consumer.
 */
export type CanonicalEntry = {
	blockNumber: number;
	blockHash: string;
	logIndex: number;
	transactionHash: string;
	transactionIndex: number;
	/** Present only when the node put it on the log itself. */
	blockTimestamp?: number;
	address: string;
	topics: string[];
	data: string;
};

/**
 * ONE entry as the RETRACTION-AWARE feed hands it back: the raw log, plus the
 * verdict the fold reached about it.
 *
 * That view exists to SHOW reorgs, so the verdict is the field that makes it
 * useful: a consumer acts optimistically on an entry and cancels the pending
 * action when the same entry arrives again taken back.
 */
export type FeedEntry = CanonicalEntry & {
	/** `true` when this entry TAKES BACK an earlier one, at that entry's original block. */
	removed: boolean;
};

/**
 * One stored row, back in the shape it arrived in.
 *
 * The topics are re-gathered from their columns and TRAILING absences are
 * dropped rather than sent as `null`: a log carries however many topics it
 * carries, and an anonymous one carries none at all, so a fixed-length array
 * with holes in it would be a shape no node ever emits.
 */
export function entryOf(row: EmissionRow): CanonicalEntry {
	const topics: string[] = [];
	for (const topic of [row.topic0, row.topic1, row.topic2, row.topic3]) {
		if (topic === null || topic === undefined) break;
		topics.push(topic);
	}
	const entry: CanonicalEntry = {
		blockNumber: Number(row.blockNumber),
		blockHash: row.blockHash,
		logIndex: Number(row.logIndex),
		transactionHash: row.transactionHash,
		transactionIndex: Number(row.transactionIndex),
		address: row.address,
		topics,
		data: row.data,
	};
	if (row.blockTimestamp !== null && row.blockTimestamp !== undefined) {
		entry.blockTimestamp = Number(row.blockTimestamp);
	}
	return entry;
}

/** The columns both views select, spelled once so their reads cannot disagree about the shape. */
export const EMISSION_COLUMNS = `seq, removed, blockNumber, blockHash, logIndex, transactionHash, transactionIndex,
	        blockTimestamp, address, topic0, topic1, topic2, topic3, data`;
