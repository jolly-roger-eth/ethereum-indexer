import type {RemoteSQL} from 'remote-sql';
import {EMISSION_STREAM_TABLE} from '../emissions.js';
import {EMISSION_COLUMNS, entryOf, type EmissionRow, type FeedEntry} from './entries.js';

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
				`SELECT ${EMISSION_COLUMNS}
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
		entries: page.map(feedEntryOf),
		// the LAST `seq` served, which is the whole hole-tolerance of this view in
		// one expression
		position: page.length > 0 ? Number((page[page.length - 1] as EmissionRow).seq) : query.after,
		hasMore,
	};
}

/**
 * One stored row as THIS view hands it back: the raw log, plus the verdict.
 *
 * The verdict is the whole difference between the two views, which is why it is
 * added here rather than carried through the shared mapper: the canonical view
 * has no entry to put a `false` on.
 */
function feedEntryOf(row: EmissionRow): FeedEntry {
	return {...entryOf(row), removed: row.removed === 1};
}
