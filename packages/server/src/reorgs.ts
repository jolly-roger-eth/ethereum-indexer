import type {ReorgCause, ReorgDetection} from '@etherfold/core';
import type {RemoteSQL} from 'remote-sql';

/**
 * How many reverts of each kind this database has seen, and the last one.
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
	last?: ReorgDetection & {at: string};
};

const COUNTER_KEY: Record<ReorgCause, string> = {
	absence: 'reorgs.absence',
	contradiction: 'reorgs.contradiction',
};
const LAST_KEY = 'reorgs.last';

/**
 * Count a revert, in the DATABASE rather than in this process.
 *
 * `lastError` on the status route is deliberately in memory, because an error
 * worth reporting there is frequently an error TALKING to the database. This is
 * the opposite case and gets the opposite answer: what an operator needs is a
 * RATE over time, and a counter that resets whenever a Worker isolate is
 * recycled measures the isolate, not the chain. Several instances sharing one
 * database must also share one count, which only the database can give them.
 *
 * One `batch`, so the counter and the "last one" never disagree. Best-effort by
 * design: it is written AFTER the batch was applied, so a crash in between loses
 * a count rather than a block. An operational counter that could roll back the
 * state it describes would be a far worse trade.
 */
export async function recordReorg(db: RemoteSQL, reorg: ReorgDetection): Promise<void> {
	await db.batch([
		db
			.prepare(
				`INSERT INTO Meta (key, value) VALUES (?1, '1')
				 ON CONFLICT (key) DO UPDATE SET value = CAST(Meta.value AS INTEGER) + 1`,
			)
			.bind(COUNTER_KEY[reorg.cause]),
		db
			.prepare(
				`INSERT INTO Meta (key, value) VALUES (?1, ?2)
				 ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
			)
			.bind(LAST_KEY, JSON.stringify({...reorg, at: new Date().toISOString()})),
	]);
}

/**
 * What the status route reports.
 *
 * Returns zeroes rather than throwing when the rows are absent, because a server
 * that has seen no reorg is the normal state and "no row" is how that is stored.
 */
export async function readReorgCounters(db: RemoteSQL): Promise<ReorgCounters> {
	const result = await db
		.prepare(`SELECT key, value FROM Meta WHERE key IN (?1, ?2, ?3)`)
		.bind(COUNTER_KEY.absence, COUNTER_KEY.contradiction, LAST_KEY)
		.all<{key: string; value: string}>();

	const rows = new Map(result.results.map((row) => [row.key, row.value]));
	const counters: ReorgCounters = {
		absence: Number(rows.get(COUNTER_KEY.absence) ?? 0),
		contradiction: Number(rows.get(COUNTER_KEY.contradiction) ?? 0),
	};
	const last = rows.get(LAST_KEY);
	if (last) {
		try {
			counters.last = JSON.parse(last) as ReorgDetection & {at: string};
		} catch {
			// a corrupt row is not worth failing a status read over: the counts, which
			// are what an alert watches, are still true
		}
	}
	return counters;
}
