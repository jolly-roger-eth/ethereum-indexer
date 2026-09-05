import type {RemoteSQL, SQLPreparedStatement} from 'remote-sql';
import {EMISSION_STREAM_TABLE} from './emissions.js';

// ---------------------------------------------------------------------------------------------------
// PAIR-COMPACTION: RECLAIM A RETRACTED ENTRY TOGETHER WITH ITS RETRACTION
// ---------------------------------------------------------------------------------------------------
// The one thing that ever DELETES from the stored emission stream, and it exists
// under three decisions this module follows rather than re-derives.
//
// ## Why it is allowed to exist at all: it is ANSWER-PRESERVING by construction
//
// A retracted entry and the retraction that took it back are a matched pair with
// no net effect: the entry is `alive = 0` and the retraction is `removed = 1,
// alive = 0`, so BOTH rows are already excluded by the canonical view, whose
// whole filter is `alive = 1`. Dropping them therefore cannot change a single
// gated read -- not by construction of a careful query, but because the rows were
// never in the answer. That is also what keeps a from-genesis REPLAY consistent
// (ADR-0006): an apply/retract pair has no net effect on a reducer whose revert
// is exact, so a rebuild over a compacted stream lands on the same state.
//
// The only observer is a consumer LAGGING FURTHER BEHIND THAN FINALITY, and it
// observes this in exactly two places. On the `seq`-ordered feed it sees those
// two entries absent rather than delivered, and the holes left behind are legal
// by contract (ADR-0006; the feed cursor carries the `seq` it was actually served
// rather than incrementing). On the canonical view, a cursor minted before a
// reorg whose pair has SINCE been compacted can no longer have that reorg named
// as its fork block, because `forkBlockSince` finds the fork by looking for
// retraction rows above the cursor's mark. Both are the same consumer: one that
// stopped reading before a reorg and came back only after it had fallen below the
// configured depth, which is already outside the window a consumer may rely on.
// It is why the depth's floor is the finality depth rather than a preference, and
// why the safe direction for an operator is a LARGER depth.
//
// ## The DEPTH: block numbers, with the finality depth as the FLOOR (ADR-0019)
//
// The unit is block numbers and no other, for the reason retention refuses a
// duration outright: time prunes on the wrong clock. A stalled indexer would drop
// history it never finished writing, and a halted chain would expire its window
// while its tip stands still. And a depth that would reach at or above
// `latestBlock - finality` is REFUSED naming the floor rather than clamped to it,
// because inside that window a retraction can still arrive -- a pair compacted
// there is a reorg the stream can no longer explain.
//
// ## The SHAPE: a call the host schedules, doing bounded work (ADR-0022)
//
// It is not a side effect of an append. The cost is proportional to what it
// drops, so putting it on the write path would stall whichever batch happened to
// cross a threshold for work that batch did not cause, and it would have this
// package choose a maintenance cadence on behalf of a browser tab, a backfilling
// CLI and a long-running server, which want three different ones. So OFF BY
// DEFAULT falls out of nobody calling it, and the configuration merely declares
// the window.
//
// One call does BOUNDED work rather than deleting by an open predicate: it reads
// at most `maxPairs * 2` candidate rows and deletes at most `maxPairs` pairs,
// naming every row by its `seq`. The one-line `DELETE ... WHERE` is the shape
// that runs on a local file and is rejected by a hosted backend capping rows
// written or wall-clock per request, and `remote-sql` reports no affected-row
// count, so a blind bounded delete could report neither what it did nor whether
// it had finished.
// ---------------------------------------------------------------------------------------------------

/**
 * What a deployment WRITES: a distance in block numbers, or off.
 *
 * `{blocks: N}` and never a bare `N`, spelled exactly as retention's
 * `RetentionSetting` spells the same unit, because it IS the same unit and a
 * second spelling would be a second thing to get wrong. `'off'` and an absent
 * setting are the same answer, and it is the DEFAULT: pair-compaction is
 * irreversible, and the stream's completeness is what makes a processor upgrade
 * a local replay rather than a re-fetch from the chain (ADR-0008).
 */
export type PairCompactionSetting = 'off' | {readonly blocks: number};

/** What a setting RESOLVES to, once the floor has been checked against it. */
export type PairCompaction = {readonly kind: 'off'} | {readonly kind: 'window'; readonly blocks: number};

/** What `resolvePairCompaction` needs to know besides the setting itself. */
export type PairCompactionOptions = {
	/**
	 * The reorg depth this stream protects against, in block numbers: the same
	 * `stream.finality` the fetcher and the stream-builder resolved.
	 *
	 * REQUIRED alongside a window, because a compaction depth is only meaningful
	 * next to the depth it must not go under.
	 */
	readonly finality: number;
};

/** A stream where nothing is ever reclaimed, which is what a deployment that says nothing gets. */
export const COMPACTION_OFF: PairCompaction = {kind: 'off'};

/**
 * How many pairs ONE call may drop when the caller names no budget.
 *
 * Ten delete statements' worth. A statement carries the two discriminators plus
 * one bound parameter per row it names, and `PAIRS_PER_STATEMENT` is set so that
 * comes to exactly 100 -- D1's bound-parameter cap, and the tightest of the
 * backends behind `RemoteSQL`. So the default call is one SELECT and ten DELETEs
 * inside a single batch, which fits the FREE D1 plan's 50 queries per invocation
 * with room for whatever else that invocation is doing.
 *
 * A host that wants to spread the cost passes a smaller `maxPairs` and calls more
 * often; a host that wants a whole sweep loops while `complete` is false. Neither
 * cadence is invented here.
 */
export const DEFAULT_MAX_PAIRS = 490;

/** Pairs named by one DELETE: 2 discriminators + 2 * 49 `seq` values = 100 bound parameters. */
const PAIRS_PER_STATEMENT = 49;

/** What one call was asked to do. */
export type PairCompactionQuery = {
	/** The NAMED INDEXER whose rows this touches. Never omitted: it is half the key. */
	indexer: string;
	/** WHICH stream, as `streamDigestOf` renders it. The other half. */
	stream: string;
	/**
	 * What the DEPLOYMENT configured. Absent is `'off'`, which is the default and
	 * deletes nothing.
	 */
	compaction?: PairCompactionSetting;
	/** The reorg depth this stream protects against (`stream.finality`). */
	finality: number;
	/**
	 * The chain tip the floor is measured back from.
	 *
	 * Supplied by the HOST rather than read from the table: the highest block this
	 * stream carries a log at is the highest EVENT-BEARING block (median 429 blocks
	 * behind on the real measured stream), which is not the tip and would make the
	 * depth mean something other than what an operator configured.
	 */
	latestBlock: number;
	/** How many pairs this call may drop. Defaults to `DEFAULT_MAX_PAIRS`. */
	maxPairs?: number;
};

/** What one call actually did, as data rather than as a log line. */
export type PairCompactionReport = {
	/**
	 * The block STRICTLY BELOW which a pair could be dropped, or `undefined` when
	 * this deployment compacts nothing.
	 *
	 * Strictly below, so that a depth exactly AT the finality floor touches nothing
	 * at or above `latestBlock - finality` -- which is what makes the floor a legal
	 * value rather than the first illegal one.
	 */
	readonly floor: number | undefined;
	/** How many matched pairs were reclaimed. */
	readonly pairsCompacted: number;
	/** How many rows were physically deleted. Always twice the pairs, and reported because that IS the invariant. */
	readonly rowsDeleted: number;
	/** How many candidate rows this call read. The bound on its work, made visible. */
	readonly scanned: number;
	/** Whether the scan reached the end of the candidates. `false` only when the budget stopped it. */
	readonly complete: boolean;
};

/**
 * Read a deployment's setting into the resolved window, or throw.
 *
 * Exported beside the verb so a host can validate its configuration at STARTUP
 * rather than discovering it at the first scheduled call, in the small hours,
 * from a scheduler nobody is watching. The verb resolves too, so the floor cannot
 * be bypassed by handing it a window nobody checked.
 *
 * Both refusals are decisions this repo already made, quoted here rather than
 * re-argued:
 *
 * - **A unit other than block numbers** is refused on every spelling (ADR-0019).
 *   Time prunes on wall-clock progress rather than chain progress, and a count of
 *   anything else resolves to a floor block number above this seam.
 * - **A depth below the finality depth** is refused naming BOTH numbers, and is
 *   never clamped to the floor. Clamping is accept-and-ignore: an operator who
 *   configured 2 against a finality of 64 believes something untrue about this
 *   deployment, and a silent correction leaves the belief in place.
 */
export function resolvePairCompaction(
	setting: PairCompactionSetting | undefined,
	options: PairCompactionOptions,
): PairCompaction {
	if (setting === undefined || setting === 'off') return COMPACTION_OFF;

	if (typeof setting !== 'object' || setting === null || !('blocks' in setting)) {
		throw new Error(
			`invalid pair-compaction depth: ${JSON.stringify(setting)}. A compaction depth is measured in BLOCK ` +
				`NUMBERS and in no other unit: write {blocks: N}, or 'off' (the default). A duration is refused because ` +
				`it would compact on wall-clock progress rather than chain progress -- a stalled indexer would drop ` +
				`history it never finished writing, and a halted chain would expire its window while its tip stands ` +
				`still (ADR-0019).`,
		);
	}

	const blocks = (setting as {blocks: unknown}).blocks;
	if (typeof blocks !== 'number' || !Number.isInteger(blocks) || blocks < 0) {
		throw new Error(
			`invalid pair-compaction depth: ${JSON.stringify(blocks)}. A depth is a distance in blocks, so it must be ` +
				`a non-negative integer.`,
		);
	}

	const {finality} = options ?? {};
	if (finality === undefined) {
		throw new Error(
			`a pair-compaction depth of ${blocks} blocks states no finality depth to stand on. A retraction can still ` +
				`arrive inside the finality window, so a depth is only meaningful next to the depth it must not go ` +
				`under: pass the stream's finality alongside it.`,
		);
	}
	if (!Number.isInteger(finality) || finality < 0) {
		throw new Error(`invalid finality depth: ${JSON.stringify(finality)}. Expected a non-negative integer.`);
	}
	if (blocks < finality) {
		throw new Error(
			`pair-compaction depth of ${blocks} blocks is below the finality depth of ${finality}, so it would compact ` +
				`at or above latestBlock - ${finality}: inside the window where a retraction can still arrive. The ` +
				`finality depth is the FLOOR and not a suggestion, and this is REFUSED rather than clamped to it, so ` +
				`that a depth nobody meant is corrected in the configuration and not silently in the server. Set the ` +
				`depth to ${finality} or more, or leave it off.`,
		);
	}

	return {kind: 'window', blocks};
}

/**
 * Reclaim matched pairs below the configured depth, doing bounded work.
 *
 * ## What a PAIR is, and why nothing here can drop half of one
 *
 * A pair is one DEAD APPLICATION (`removed = 0, alive = 0`) and one RETRACTION
 * (`removed = 1`) of the SAME log: the same `(blockNumber, blockHash, logIndex)`,
 * because a retraction is appended at its original block and a block is retracted
 * by HASH. Both are found in one scan and both `seq` values are named in one
 * DELETE inside one batch, so a half-dropped pair is not an outcome this can
 * have. A row with no partner in the page -- an orphan retraction, or an entry
 * whose retraction fell beyond the budget -- is simply not compacted this call.
 *
 * A LIVE row is never a candidate, however old: `alive = 1` is the canonical
 * view's answer, and this is the one delete in the system that must not be able
 * to change one.
 *
 * ## Why the scan is ordered by BLOCK and not by `seq`
 *
 * Ordering by `(blockNumber, logIndex, blockHash, seq)` puts the two rows of a
 * pair NEXT TO EACH OTHER, so pairing is local to the page and a budget can never
 * cut between an entry and its retraction while leaving the entry first in line.
 * Ordering by `seq` -- the table's primary key, and the cheaper scan -- would put
 * an entry and its retraction an arbitrary number of rows apart, and a small
 * budget would then read a page of entries whose retractions are all just past
 * the end and make no progress at all.
 *
 * Neither order rides an index: the canonical index is PARTIAL on `alive = 1`, so
 * every scan over dead rows is a table scan over this `(indexer, stream)`'s rows
 * whatever the order. An index for it is deliberately NOT added here -- it would
 * be a third index on a table already weighed against D1's 10GB ceiling, paid for
 * by every deployment, to serve a feature that is off by default. The day a
 * deployment schedules this often enough to care is the day the index earns its
 * keep.
 */
export async function compactEmissionPairs(db: RemoteSQL, query: PairCompactionQuery): Promise<PairCompactionReport> {
	const compaction = resolvePairCompaction(query.compaction, {finality: query.finality});
	if (compaction.kind === 'off') {
		return {floor: undefined, pairsCompacted: 0, rowsDeleted: 0, scanned: 0, complete: true};
	}

	const {latestBlock} = query;
	if (typeof latestBlock !== 'number' || !Number.isInteger(latestBlock) || latestBlock < 0) {
		throw new Error(
			`invalid latestBlock: ${JSON.stringify(latestBlock)}. The depth is measured back from the chain tip, so ` +
				`the tip must be a whole non-negative block number.`,
		);
	}
	const maxPairs = budgetOf(query.maxPairs);

	// never negative: a chain younger than its own compaction depth has nothing
	// far enough behind to reclaim
	const floor = Math.max(0, latestBlock - compaction.blocks);
	const scanLimit = maxPairs * 2;

	const candidates = (
		await db
			.prepare(
				`SELECT seq, blockNumber, blockHash, logIndex, removed
				 FROM ${EMISSION_STREAM_TABLE}
				 WHERE indexer = ?1 AND stream = ?2 AND alive = 0 AND blockNumber < ?3
				 ORDER BY blockNumber, logIndex, blockHash, seq
				 LIMIT ?4`,
			)
			.bind(query.indexer, query.stream, floor, scanLimit)
			.all<{seq: number; blockNumber: number; blockHash: string; logIndex: number; removed: number}>()
	).results;

	const pairs = pairsIn(candidates, maxPairs);
	if (pairs.length > 0) {
		await db.batch(deletionsOf(db, query.indexer, query.stream, pairs));
	}

	return {
		floor,
		pairsCompacted: pairs.length,
		rowsDeleted: pairs.length * 2,
		scanned: candidates.length,
		complete: candidates.length < scanLimit,
	};
}

/**
 * Match the candidates into pairs, up to the budget.
 *
 * The rows arrive grouped by `(blockNumber, logIndex, blockHash)` and ordered by
 * `seq` within a group, so this walks the groups and pairs the k-th dead entry
 * with the k-th retraction. A group can hold more than one of each -- a block
 * applied, retracted, and applied again under the same hash before dying a second
 * time -- and pairing in `seq` order is what keeps each retraction with the entry
 * it actually took back.
 *
 * Whatever is left over is left ALONE, which is the one rule that matters here:
 * a retraction with no entry would advertise a reorg of something absent, and an
 * entry with no retraction would read as live.
 */
function pairsIn(
	rows: readonly {seq: number; blockNumber: number; blockHash: string; logIndex: number; removed: number}[],
	maxPairs: number,
): {dead: number; retraction: number}[] {
	const pairs: {dead: number; retraction: number}[] = [];
	let group: string | undefined;
	let dead: number[] = [];
	let retractions: number[] = [];

	const close = () => {
		for (let i = 0; i < Math.min(dead.length, retractions.length) && pairs.length < maxPairs; i++) {
			pairs.push({dead: dead[i] as number, retraction: retractions[i] as number});
		}
		dead = [];
		retractions = [];
	};

	for (const row of rows) {
		const key = `${row.blockNumber}:${row.logIndex}:${row.blockHash}`;
		if (key !== group) {
			close();
			group = key;
		}
		(row.removed === 1 ? retractions : dead).push(Number(row.seq));
	}
	close();

	return pairs;
}

/**
 * The deletions, as statements naming every row by `seq`.
 *
 * Chunked so no statement carries more bound parameters than the tightest
 * backend allows, and chunked BY PAIR so a chunk boundary never falls between an
 * entry and its retraction. The whole set goes through `batch()`, so a
 * half-compacted stream is not a state the next read can see.
 */
function deletionsOf(
	db: RemoteSQL,
	indexer: string,
	stream: string,
	pairs: readonly {dead: number; retraction: number}[],
): SQLPreparedStatement[] {
	const statements: SQLPreparedStatement[] = [];
	for (let at = 0; at < pairs.length; at += PAIRS_PER_STATEMENT) {
		const chunk = pairs.slice(at, at + PAIRS_PER_STATEMENT);
		const seqs = chunk.flatMap((pair) => [pair.dead, pair.retraction]);
		const placeholders = seqs.map((_, index) => `?${index + 3}`).join(', ');
		statements.push(
			db
				.prepare(
					`DELETE FROM ${EMISSION_STREAM_TABLE}
					 WHERE indexer = ?1 AND stream = ?2 AND seq IN (${placeholders})`,
				)
				.bind(indexer, stream, ...seqs),
		);
	}
	return statements;
}

/**
 * Validate the budget, in the words every bounded verb in this repo uses.
 *
 * Zero is refused rather than read as "do nothing": a caller that computed a
 * budget of zero computed it wrongly, and a silent no-op would let a stream grow
 * for ever while its owner watched a compaction run on schedule.
 */
function budgetOf(maxPairs: number | undefined): number {
	if (maxPairs === undefined) return DEFAULT_MAX_PAIRS;
	if (!Number.isInteger(maxPairs) || maxPairs < 1) {
		throw new Error(
			`invalid compaction budget: ${JSON.stringify(maxPairs)}. maxPairs is a whole number of PAIRS to reclaim, ` +
				`at least 1; leave it unset for ${DEFAULT_MAX_PAIRS}.`,
		);
	}
	return maxPairs;
}
