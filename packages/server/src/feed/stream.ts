import type {RemoteSQL} from 'remote-sql';
import {EMISSION_STREAM_TABLE} from '../emissions.js';

// ---------------------------------------------------------------------------------------------------
// THE RETRACTION-AWARE VIEW: THE STORED STREAM IN `seq` ORDER, RETRACTIONS INCLUDED
// ---------------------------------------------------------------------------------------------------
// The first of ADR-0006's two views over one table. This one is for a consumer
// that WANTS to see reorgs: it acts optimistically on a log and cancels the
// pending action when the retraction arrives. So `removed` entries are DELIVERED
// and `alive` is not consulted at all -- filtering on it is the OTHER view's
// rule, and doing it here would hide exactly what this view exists to show.
//
// ## Holes in `seq` are legal, which decides the whole read
//
// The page is `seq > <position> ORDER BY seq LIMIT n`, and the next position is
// the `seq` of the LAST ROW ACTUALLY SERVED -- never the previous position plus
// the number of rows, and never one past anything. Pair-compaction (a later task)
// drops a retracted entry together with its retraction and leaves the surrounding
// numbers where they were, so contiguity was never available to assume; a read
// that assumed it would stall on the first hole wider than a page.
//
// The scan rides the table's PRIMARY KEY `(indexer, stream, seq)`, so it is an
// index range scan with both discriminators bound. Neither is ever omitted:
// omitting the name would serve another tenant's rows under a `seq` that means
// something else there, which is what the discriminators exist to prevent.
// ---------------------------------------------------------------------------------------------------

/**
 * ONE entry as a consumer receives it: the raw log the node reported, plus the
 * verdict the fold reached about it.
 *
 * The same shape as `EmittedLog` in `@etherfold/core` (a `NumberifiedLog`), so
 * what goes in the table and what comes out of the feed are one vocabulary,
 * minus the `0x`-branded types: a row read back out of SQLite carries no proof
 * of its own shape, and claiming one would be a cast pretending to be a check.
 *
 * There is deliberately NO `seq` on it, and no `alive`. `seq` is the CURSOR's
 * business -- publishing it is how a consumer ends up incrementing it, which
 * holes make wrong -- and `alive` is a derived flag the other view reads; a
 * retraction-aware consumer learns the same fact from the retraction ARRIVING.
 */
export type FeedEntry = {
	/** `true` when this entry TAKES BACK an earlier one, at that entry's original block. */
	removed: boolean;
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

/** One page, plus the position to resume from and whether anything is left. */
export type FeedPage = {
	entries: FeedEntry[];
	/**
	 * The `seq` of the LAST entry on this page, or the position asked from when the
	 * page is empty. Never derived by arithmetic.
	 */
	position: number;
	hasMore: boolean;
};

/** The position a feed starts at: "everything, since `seq` is one-based". */
export const FEED_START_POSITION = 0;

type EmissionRow = {
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
 * Read one page of the `seq`-ordered stream, strictly after `after`.
 *
 * `limit + 1` rows are asked for and the extra one is dropped: that is what makes
 * `hasMore` a fact rather than a guess, and it costs one row rather than a second
 * COUNT over the same range.
 */
export async function readStreamFeed(
	db: RemoteSQL,
	query: {indexer: string; stream: string; after: number; limit: number},
): Promise<FeedPage> {
	const rows = (
		await db
			.prepare(
				`SELECT seq, removed, blockNumber, blockHash, logIndex, transactionHash, transactionIndex,
				        blockTimestamp, address, topic0, topic1, topic2, topic3, data
				 FROM ${EMISSION_STREAM_TABLE}
				 WHERE indexer = ?1 AND stream = ?2 AND seq > ?3
				 ORDER BY seq
				 LIMIT ?4`,
			)
			.bind(query.indexer, query.stream, query.after, query.limit + 1)
			.all<EmissionRow>()
	).results;

	const hasMore = rows.length > query.limit;
	const page = hasMore ? rows.slice(0, query.limit) : rows;

	return {
		entries: page.map(entryOf),
		// the LAST `seq` served, which is the whole hole-tolerance of this view in
		// one expression
		position: page.length > 0 ? Number((page[page.length - 1] as EmissionRow).seq) : query.after,
		hasMore,
	};
}

/**
 * One stored row, back in the shape it arrived in.
 *
 * The topics are re-gathered from their columns and TRAILING absences are
 * dropped rather than sent as `null`: a log carries however many topics it
 * carries, and an anonymous one carries none at all, so a fixed-length array
 * with holes in it would be a shape no node ever emits.
 */
function entryOf(row: EmissionRow): FeedEntry {
	const topics: string[] = [];
	for (const topic of [row.topic0, row.topic1, row.topic2, row.topic3]) {
		if (topic === null || topic === undefined) break;
		topics.push(topic);
	}
	const entry: FeedEntry = {
		removed: row.removed === 1,
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
