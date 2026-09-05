import {REORG_COUNTER_KEY, REORG_LAST_KEY, type ReorgDetection, type ReorgRecorder} from '@etherfold/core';
import type {RemoteSQL} from 'remote-sql';

// ---------------------------------------------------------------------------------------------------
// THE ONE PLACE A CONCLUDED REORG IS WRITTEN DOWN
// ---------------------------------------------------------------------------------------------------
// It used to be the HTTP ingest route, which made an operational counter a fact
// about the TRANSPORT rather than about the fold: `etherfold run` folds through
// `createDirectIngestion`, never touches a route, and reported
// `{absence: 0, contradiction: 0}` for ever while `etherfold index` folding the
// identical chain reported the revert it made.
//
// So the write moved to where the STORE is owned, which is here: all three
// folding commands (`run`, `build`, `index`) open their database through
// `buildProcessor`, and every one of them gets the same recorder bound to the
// same handle. `@etherfold/core` decides WHEN (once, inside
// `StreamBuilder.receive`) and under WHICH KEYS; this decides where the row
// goes. ADR-0050.
//
// It is deliberately NOT in `@etherfold/server`: that would make the CLI depend
// on the server package for a write to a database the CLI itself opened, and it
// is the server -- the read tier especially -- that must be able to read these
// counts off a database it did not write.
// ---------------------------------------------------------------------------------------------------

/**
 * Count one concluded revert in the DATABASE rather than in this process.
 *
 * `lastError` on the status route is deliberately in memory, because an error
 * worth reporting there is frequently an error TALKING to the database. This is
 * the opposite case and gets the opposite answer: what an operator needs is a
 * RATE over time, and a counter that resets whenever a process is restarted
 * measures the process, not the chain. Several processes sharing one database
 * must also share one count, which only the database can give them.
 *
 * One `batch`, so the counter and the "last one" never disagree.
 *
 * It may FAIL, and failing is safe: the caller
 * (`StreamBuilder.noteReorg`) catches and logs, because it is written AFTER the
 * batch was applied and losing a count is a far better trade than rolling back
 * the state it describes. The ordinary way it fails is a database whose
 * fixed-table schema was never applied (`--no-auto-setup`), and a fold must not
 * care.
 */
export async function recordReorg(db: RemoteSQL, reorg: ReorgDetection): Promise<void> {
	await db.batch([
		db
			.prepare(
				`INSERT INTO Meta (key, value) VALUES (?1, '1')
				 ON CONFLICT (key) DO UPDATE SET value = CAST(Meta.value AS INTEGER) + 1`,
			)
			.bind(REORG_COUNTER_KEY[reorg.cause]),
		db
			.prepare(
				`INSERT INTO Meta (key, value) VALUES (?1, ?2)
				 ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
			)
			.bind(REORG_LAST_KEY, JSON.stringify({...reorg, at: new Date().toISOString()})),
	]);
}

/**
 * The recorder a receiver is built with, bound to the handle this process folds
 * into.
 *
 * One function so that the three folding commands cannot bind it to three
 * different things: whatever `buildProcessor` opened is what gets counted into.
 */
export function reorgRecorderFor(db: RemoteSQL): ReorgRecorder {
	return (reorg) => recordReorg(db, reorg);
}
