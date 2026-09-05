import {REORG_COUNTER_KEY, REORG_LAST_KEY, type RecordedReorg, type ReorgCounters} from '@etherfold/core';
import type {RemoteSQL} from 'remote-sql';

export type {RecordedReorg, ReorgCounters};

/**
 * What the status route reports, read off the DATABASE and not off this process.
 *
 * ## Why this package only READS them
 *
 * It used to write them too, from the ingest route, and that made the count a
 * fact about the TRANSPORT: a combined `etherfold run` folds through
 * `createDirectIngestion`, touches no route, and reported `{absence: 0,
 * contradiction: 0}` for ever while an `index` process folding the identical
 * chain reported the revert it made. A reorg is concluded by the FOLD, so the
 * count is taken where the fold happens -- once, inside `StreamBuilder.receive`,
 * through a `ReorgRecorder` the process that OWNS the store supplies (ADR-0050).
 * The ingest route is a caller of that path now rather than its owner.
 *
 * The READ stays here, and is not the mirror image of that argument. A read tier
 * (`etherfold serve`) owns no store, holds no processor and folds nothing: it is
 * a database connection and an HTTP surface, so the only thing that can answer
 * "how many reverts does this database record" is this route. That is also why
 * the key names live in `@etherfold/core` rather than in either end -- one name,
 * two packages, no chance of them describing different rows.
 *
 * Returns zeroes rather than throwing when the rows are absent, because a
 * database that has seen no reorg is the normal state and "no row" is how that
 * is stored.
 */
export async function readReorgCounters(db: RemoteSQL): Promise<ReorgCounters> {
	const result = await db
		.prepare(`SELECT key, value FROM _meta WHERE key IN (?1, ?2, ?3)`)
		.bind(REORG_COUNTER_KEY.absence, REORG_COUNTER_KEY.contradiction, REORG_LAST_KEY)
		.all<{key: string; value: string}>();

	const rows = new Map(result.results.map((row) => [row.key, row.value]));
	const counters: ReorgCounters = {
		absence: Number(rows.get(REORG_COUNTER_KEY.absence) ?? 0),
		contradiction: Number(rows.get(REORG_COUNTER_KEY.contradiction) ?? 0),
	};
	const last = rows.get(REORG_LAST_KEY);
	if (last) {
		try {
			counters.last = JSON.parse(last) as RecordedReorg;
		} catch {
			// a corrupt row is not worth failing a status read over: the counts, which
			// are what an alert watches, are still true
		}
	}
	return counters;
}
