import {REORG_COUNTER_KEY, REORG_LAST_KEY, type ReorgRecorder} from '@etherfold/core';
import type {RemoteSQL} from 'remote-sql';

/**
 * Count a concluded reorg the way a HOST does, because this package no longer
 * does it and must not.
 *
 * The write used to live on the ingest route, which made an operational counter
 * a fact about the TRANSPORT: a combined `etherfold run` folds through
 * `createDirectIngestion`, reaches no route, and reported no reverts at all. It
 * is taken once inside `StreamBuilder.receive` now, through a recorder the
 * process that OWNS the store supplies (ADR-0050), and this route is a CALLER of
 * that path.
 *
 * So a server test that wants a count has to be a host, which is what this is:
 * the shipped writer is `etherfold`'s `recordReorg`, and this package cannot
 * depend on the CLI that depends on it. What the two share is the KEY, from
 * `@etherfold/core`, so neither end spells the name itself.
 */
export function hostRecorderFor(db: RemoteSQL): ReorgRecorder {
	return async (reorg) => {
		await db.batch([
			db
				.prepare(
					`INSERT INTO _meta (key, value) VALUES (?1, '1')
					 ON CONFLICT (key) DO UPDATE SET value = CAST(_meta.value AS INTEGER) + 1`,
				)
				.bind(REORG_COUNTER_KEY[reorg.cause]),
			db
				.prepare(
					`INSERT INTO _meta (key, value) VALUES (?1, ?2)
					 ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
				)
				.bind(REORG_LAST_KEY, JSON.stringify({...reorg, at: new Date().toISOString()})),
		]);
	};
}
