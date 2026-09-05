import type {RemoteSQL} from 'remote-sql';
import {EMISSION_STREAM_TABLE} from '../emissions.js';
import {EMISSION_COLUMNS, entryOf, type CanonicalEntry, type EmissionRow} from './entries.js';

// ---------------------------------------------------------------------------------------------------
// THE CANONICAL VIEW: LIVE ENTRIES ONLY, UNDER THE CALLER'S GATE, IN CHAIN ORDER
// ---------------------------------------------------------------------------------------------------
// The second of ADR-0006's two views over the one stored table:
// `WHERE alive AND blockNumber <= gate` ordered by `(blockNumber, logIndex)`.
// This is the view for a consumer that never wants to hear the word reorg, so
// its ENTIRE sync state is one advancing position and it implements no reorg
// handling of its own.
//
// The read is exactly the partial index `EmissionStreamCanonical` was created
// for -- `(indexer, stream, blockNumber, logIndex) WHERE alive = 1` -- so the
// retractions and the rows they killed cost nothing to skip. That index is why
// ADR-0006 could keep ONE table with a flag rather than a second table: this
// view is a cheap derived read and not a materialised copy.
//
// ## What the view HIDES, and therefore what it OWES
//
// It hides reorgs. A consumer that resumed at `(105, 3)` after block 105 was
// replaced would be served the NEW branch from that key onward and would
// silently never see the new 103, 104 and 105 -- exactly the events it never
// received. So this view owes a compensating guarantee: the cursor carries the
// BLOCK HASH the consumer last saw, the server VALIDATES it, and a cursor whose
// block is no longer canonical answers REWIND TO FORK BLOCK F.
//
// **One hash check is provably enough.** A reorg invalidates a CONTIGUOUS
// SUFFIX of the chain, so if the block at the cursor is still canonical then the
// whole prefix behind it is too. Nothing walks back over the window.
//
// ## The GATE is the CALLER's, and the server does not choose one
//
// A consumer that only wants final data passes a low gate; one that wants the
// tip passes a high one (ADR-0007's two lanes). Defaulting it -- to the tip, to
// `latestBlock - finality`, to anything -- would be the server deciding a
// consumer's risk appetite, which is the one thing about a consumer this system
// deliberately knows nothing about (ADR-0005). It is therefore REQUIRED on the
// request rather than defaulted.
// ---------------------------------------------------------------------------------------------------

/**
 * WHERE a consumer of this view is, in the view's OWN terms.
 *
 * `(blockNumber, logIndex)` is the POSITION and the only thing the read
 * advances on. It is deliberately not a `seq`: a synthetic sequence is the other
 * view's cursor, and it is wrong here because this view's order is the chain's.
 */
export type CanonicalPosition = {
	blockNumber: number;
	logIndex: number;
};

/**
 * The position a consumer that has seen nothing starts at.
 *
 * `logIndex: -1` rather than `0` because the read is STRICTLY after the
 * position, and a genuine log at `(0, 0)` must not be the one entry a fresh
 * consumer never receives. There is no block 0 with logs on any chain we index,
 * which is exactly why relying on that would be a silent bug rather than an
 * obvious one.
 */
export const CANONICAL_START_POSITION: CanonicalPosition = {blockNumber: 0, logIndex: -1};

/** One page of the canonical view. */
export type CanonicalPage = {
	entries: CanonicalEntry[];
	/**
	 * The LAST entry actually served, or `undefined` on an empty page.
	 *
	 * It carries the block HASH as well as the position, because the hash is what
	 * the next request validates: a cursor names an entry this server served, and
	 * the hash is the proof of which chain it was on.
	 */
	last?: CanonicalPosition & {blockHash: string};
	hasMore: boolean;
};

/**
 * Read one page of the canonical view, strictly after `after` and at or below
 * `gate`.
 *
 * `limit + 1` rows are asked for and the extra one is dropped: that is what
 * makes `hasMore` a fact rather than a guess, and it costs one row rather than
 * a second COUNT over the same range.
 *
 * `alive = 1` is the ONLY filter that decides what a consumer sees, and it
 * already excludes retractions: a retraction row is written `removed = 1,
 * alive = 0` and is never canonical, so this view cannot serve one. Asserting
 * `removed = 0` as well would be a second rule that could disagree with the
 * first.
 */
export async function readCanonicalView(
	db: RemoteSQL,
	query: {indexer: string; stream: string; gate: number; after: CanonicalPosition; limit: number},
): Promise<CanonicalPage> {
	const rows = (
		await db
			.prepare(
				`SELECT ${EMISSION_COLUMNS}
				 FROM ${EMISSION_STREAM_TABLE}
				 WHERE indexer = ?1 AND stream = ?2 AND alive = 1
				   AND blockNumber <= ?3
				   AND (blockNumber > ?4 OR (blockNumber = ?4 AND logIndex > ?5))
				 ORDER BY blockNumber, logIndex
				 LIMIT ?6`,
			)
			.bind(query.indexer, query.stream, query.gate, query.after.blockNumber, query.after.logIndex, query.limit + 1)
			.all<EmissionRow>()
	).results;

	const hasMore = rows.length > query.limit;
	const page = hasMore ? rows.slice(0, query.limit) : rows;
	const lastRow = page[page.length - 1];

	return {
		entries: page.map(entryOf),
		...(lastRow
			? {
					last: {
						blockNumber: Number(lastRow.blockNumber),
						logIndex: Number(lastRow.logIndex),
						blockHash: lastRow.blockHash,
					},
				}
			: {}),
		hasMore,
	};
}

/**
 * Is the block a consumer last saw still on the chain this server holds?
 *
 * ONE lookup, on the canonical index, asking the only question that matters:
 * is the entry the cursor names STILL ALIVE. A reorged-out entry answers `false`
 * whether the row survived flagged dead (the ordinary case) or was reclaimed by
 * pair-compaction together with its retraction (the later, opt-in case), because
 * neither leaves a live row behind. Asking "is it alive" rather than "was it
 * retracted" is what makes those two the same answer.
 *
 * `(blockHash, logIndex)` names ONE log -- a reorg retracts a block by HASH,
 * while a height names whichever branch won -- so this cannot be satisfied by
 * the replacement block sitting at the same number.
 */
export async function isStillCanonical(
	db: RemoteSQL,
	at: {indexer: string; stream: string; blockNumber: number; logIndex: number; blockHash: string},
): Promise<boolean> {
	const rows = (
		await db
			.prepare(
				`SELECT 1 AS live FROM ${EMISSION_STREAM_TABLE}
				 WHERE indexer = ?1 AND stream = ?2 AND blockNumber = ?3 AND logIndex = ?4 AND blockHash = ?5
				   AND alive = 1
				 LIMIT 1`,
			)
			.bind(at.indexer, at.stream, at.blockNumber, at.logIndex, at.blockHash)
			.all<{live: number}>()
	).results;
	return rows.length > 0;
}

/**
 * The FORK BLOCK: the lowest block a consumer holding this cursor must read
 * again.
 *
 * It is the lowest block number the stream has RETRACTED ANYTHING AT since the
 * cursor was minted. The `since` mark is what makes that answerable: it is the
 * stream's high-water mark at the moment the cursor was handed out, so every
 * retraction above it is a change the consumer cannot have seen, and every one
 * below it was already reflected in the page it was served (this view serves
 * live rows, so a retraction that had already happened simply removed rows from
 * its answer).
 *
 * Two things it is deliberately NOT:
 *
 * - **not the cursor's own block.** The fork can be BELOW it, and answering the
 *   cursor's block would skip exactly the blocks between -- the failure the
 *   validation exists to prevent.
 * - **not a walk back over the window.** A reorg invalidates a contiguous
 *   suffix, so the lowest retraction since the mark IS the fork; there is no
 *   need to establish which retractions belong to which reorg, and taking the
 *   MINIMUM over several is correct rather than approximate (a second, deeper
 *   reorg arriving later must move the answer DOWN).
 *
 * `undefined` means nothing has been retracted since the mark, which cannot
 * happen for a cursor that failed validation -- the retraction that killed it is
 * by definition above the mark it was minted at. The caller treats it as the
 * refusal it is rather than serving a page.
 */
export async function forkBlockSince(
	db: RemoteSQL,
	at: {indexer: string; stream: string; since: number},
): Promise<number | undefined> {
	const rows = (
		await db
			.prepare(
				`SELECT MIN(blockNumber) AS forkBlock FROM ${EMISSION_STREAM_TABLE}
				 WHERE indexer = ?1 AND stream = ?2 AND removed = 1 AND seq > ?3`,
			)
			.bind(at.indexer, at.stream, at.since)
			.all<{forkBlock: number | null}>()
	).results;
	const forkBlock = rows[0]?.forkBlock;
	return forkBlock === null || forkBlock === undefined ? undefined : Number(forkBlock);
}
