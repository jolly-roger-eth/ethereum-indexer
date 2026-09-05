import type {EmittedLog} from '@etherfold/core';
import type {RemoteSQL, SQLPreparedStatement} from 'remote-sql';

// ---------------------------------------------------------------------------------------------------
// THE STORED EMISSION STREAM: APPEND, AND FLAG WHAT WAS SUPERSEDED
// ---------------------------------------------------------------------------------------------------
// ADR-0006 decides the substance: the server keeps the emission stream the fold
// already produces -- retractions included, superseded rows FLAGGED rather than
// deleted -- because that is what the code computes, so persisting it is zero
// derivation, while the canonical view is cheaply derived from it and not the
// reverse. No retraction information is ever destroyed here.
//
// ## Why the WRITE is on the route rather than inside the fold
//
// ADR-0050 moved the reorg COUNT the other way, into `StreamBuilder.receive`,
// on the ground that a concluded reorg is a fact about the fold and not about
// the transport. The emission stream is a fact about the fold too, and it is
// still written from here, for a reason that is about the KEY rather than about
// the fact: half of it is the INDEXER NAME, and the route segment is the only
// place that value exists. `IndexerRegistryEntry` deliberately does not carry a
// name ("a second copy an entry could disagree with is a discriminator a write
// path might key on wrongly") and `--indexer` is refused on `run` and `build`
// altogether, so there is no fold-side value to key on: a receiver moved here
// would have to be told its own name, which is the duplication the registry
// refuses. Where the name lives is where the write goes.
//
// The visible consequence, recorded rather than hidden: a COMBINED `etherfold
// run` folds through `createDirectIngestion`, reaches no route, and therefore
// stores no emission stream. That is not this module declining to serve it --
// that shape has no indexer name to store one under. When it gets one, the
// receiver can be handed a writer exactly as it is handed a `ReorgRecorder`, and
// this becomes the caller of that path.
// ---------------------------------------------------------------------------------------------------

/** The table's name, spelled once so a read and a write cannot drift apart. */
export const EMISSION_STREAM_TABLE = 'EmissionStream';

/** One append: the two discriminators every row carries, and the emissions to write under them. */
export type EmissionAppend = {
	/** The NAMED INDEXER, which is the route segment a batch was posted to. */
	indexer: string;
	/**
	 * WHICH stream, as `streamDigestOf` renders it (`LogIngestion.streamDigest`).
	 *
	 * NEVER the wire context's `{source, config}`: that is a 32-bit whole-entry
	 * hash kept whole as an identity check between the two halves of a deployment
	 * (ADR-0034), so a decode-only change moves it while the fetch filter is
	 * untouched -- which as a KEY orphans every row already stored.
	 */
	stream: string;
	/** What the fold concluded, in order: applications and retractions together. */
	emissions: readonly EmittedLog[];
};

/**
 * Append one batch's emissions, flagging whatever each retraction supersedes.
 *
 * ## `seq` is allocated per `(indexer, stream)`, from the table itself
 *
 * The high-water mark is read once and the batch is numbered from it, rather
 * than a counter being kept in a process: the intended host is serverless, so
 * an in-memory sequence would be one isolate's private opinion of a value the
 * database owns -- the same argument that keeps `StreamBuilder` reading its
 * cursor on every call. Per PAIR and not per stream alone, because two named
 * indexers with byte-identical sources land on ONE stream digest and would
 * otherwise punch holes in each other's cursor space. Holes are legal by
 * contract, but they should come from compaction rather than from a neighbour.
 *
 * The allocation is not a lock: the PRIMARY KEY `(indexer, stream, seq)` is,
 * and a genuine concurrent append for one pair therefore fails loudly instead
 * of overwriting. It cannot ordinarily happen, because the cursor already
 * serialises batches -- a second one for the same receiver is a `409` before it
 * reaches here.
 *
 * ## A retraction FLAGS, and never deletes
 *
 * Two writes per retraction: the retraction row itself (appended, `removed = 1`,
 * and never `alive` -- it is not something a canonical read may return), and an
 * UPDATE setting `alive = 0` on the emission it takes back. The emission is
 * matched by `(blockHash, logIndex)`, which names ONE log: a reorg retracts a
 * block by hash, and a height names whichever branch won. `alive = 1` is part of
 * the match so that a hash applied, retracted, and applied again flags the row
 * that is live at the time rather than the one already dead.
 *
 * The whole batch goes through `batch()` so a partially-appended stream is not a
 * state the next read can see.
 */
export async function appendEmissions(db: RemoteSQL, append: EmissionAppend): Promise<void> {
	const {indexer, stream, emissions} = append;
	if (emissions.length === 0) return;

	let seq = await readStreamHighWaterMark(db, {indexer, stream});

	const statements: SQLPreparedStatement[] = [];
	for (const emission of emissions) {
		if (emission.removed) {
			statements.push(
				db
					.prepare(
						`UPDATE ${EMISSION_STREAM_TABLE} SET alive = 0
						 WHERE indexer = ?1 AND stream = ?2 AND blockHash = ?3 AND logIndex = ?4
						   AND removed = 0 AND alive = 1`,
					)
					.bind(indexer, stream, emission.blockHash, emission.logIndex),
			);
		}
		seq++;
		statements.push(insertOf(db, indexer, stream, seq, emission));
	}

	await db.batch(statements);
}

/**
 * The highest `seq` allocated for one `(indexer, stream)` pair, or `0` when
 * nothing has been appended under it yet.
 *
 * Read by the APPEND to number a batch from, and by the CANONICAL view to mark
 * the point a cursor was minted at, so that "what has been retracted since you
 * last looked" is answerable later. One expression, because the two must agree
 * about what a position in this stream means.
 */
export async function readStreamHighWaterMark(db: RemoteSQL, at: {indexer: string; stream: string}): Promise<number> {
	const read = await db
		.prepare(`SELECT COALESCE(MAX(seq), 0) AS lastSeq FROM ${EMISSION_STREAM_TABLE} WHERE indexer = ?1 AND stream = ?2`)
		.bind(at.indexer, at.stream)
		.all<{lastSeq: number}>();
	return Number(read.results[0]?.lastSeq ?? 0);
}

/**
 * One row, as the node reported it.
 *
 * The topics are SPREAD into columns rather than stored as a blob, because a
 * later node-compatible `eth_getLogs` filters on them and a blob makes that a
 * table scan (`work/specs/proposed/node-log-api.md`). A log carries at most
 * four, and fewer than four is `NULL` rather than an empty string: an anonymous
 * event has no `topic0` at all, and "absent" and "empty" must not be the same
 * value to a filter.
 */
function insertOf(
	db: RemoteSQL,
	indexer: string,
	stream: string,
	seq: number,
	emission: EmittedLog,
): SQLPreparedStatement {
	const topics = emission.topics ?? [];
	return db
		.prepare(
			`INSERT INTO ${EMISSION_STREAM_TABLE} (
				indexer, stream, seq, removed, alive,
				blockNumber, blockHash, logIndex, transactionHash, transactionIndex, blockTimestamp,
				address, topic0, topic1, topic2, topic3, data
			 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)`,
		)
		.bind(
			indexer,
			stream,
			seq,
			emission.removed ? 1 : 0,
			// a retraction is never canonical, and an application is until something
			// retracts it
			emission.removed ? 0 : 1,
			emission.blockNumber,
			emission.blockHash,
			emission.logIndex,
			emission.transactionHash,
			emission.transactionIndex,
			emission.blockTimestamp ?? null,
			emission.address,
			topics[0] ?? null,
			topics[1] ?? null,
			topics[2] ?? null,
			topics[3] ?? null,
			emission.data,
		);
}
