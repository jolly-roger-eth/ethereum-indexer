import {REORG_COUNTER_KEY, REORG_LAST_KEY} from '@etherfold/core';
import {createClient} from '@libsql/client';
import {applySchema, readReorgCounters} from '@etherfold/server';
import type {RemoteSQL} from 'remote-sql';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {describe, expect, it} from 'vitest';
import {recordReorg, reorgRecorderFor} from '../src/reorgCounters.js';

// ---------------------------------------------------------------------------------------------------
// THE WRITER, ON ITS OWN
// ---------------------------------------------------------------------------------------------------
// The equivalence suite asserts that all three deployment shapes AGREE about the
// reverts they concluded. This asserts the one thing underneath that: what the
// single writer actually puts in the database, and what it does when it cannot.
//
// The reader is `@etherfold/server`'s, deliberately: the two ends of this are in
// different packages (a read tier owns no store and still answers), and the
// assertion worth making is that what the store owner WROTE is what a server
// pointed at that database READS -- not that one module round-trips itself.
// ---------------------------------------------------------------------------------------------------

async function freshDatabase(): Promise<RemoteSQL> {
	const db = new RemoteLibSQL(createClient({url: ':memory:'}));
	await applySchema(db);
	return db;
}

describe('the reorg counter write', () => {
	it('counts each cause on its own line, because absence is an inference and contradiction is proof', async () => {
		const db = await freshDatabase();

		await recordReorg(db, {cause: 'contradiction', blockNumber: 104, blockHash: '0xa104'});
		await recordReorg(db, {cause: 'contradiction', blockNumber: 220, blockHash: '0xa220'});
		await recordReorg(db, {cause: 'absence', blockNumber: 330, blockHash: '0xa330'});

		// folding them into one number would hide the only signal that says "your logs
		// are being truncated" rather than "the chain reorged" (ADR-0004)
		expect(await readReorgCounters(db)).toMatchObject({contradiction: 2, absence: 1});
	});

	it('leaves the last one and the counts agreeing, because they are written in one batch', async () => {
		const db = await freshDatabase();

		await recordReorg(db, {cause: 'contradiction', blockNumber: 104, blockHash: '0xa104'});
		await recordReorg(db, {cause: 'absence', blockNumber: 330, blockHash: '0xa330'});

		const counters = await readReorgCounters(db);
		expect(counters.last).toMatchObject({cause: 'absence', blockNumber: 330, blockHash: '0xa330'});
		expect(counters.last?.at).toEqual(expect.any(String));
	});

	it('reports zeroes on a database that has seen none, which is the normal state', async () => {
		expect(await readReorgCounters(await freshDatabase())).toEqual({absence: 0, contradiction: 0});
	});

	it('writes under the keys `@etherfold/core` names, so the reader cannot drift from it', async () => {
		const db = await freshDatabase();
		await recordReorg(db, {cause: 'absence', blockNumber: 7, blockHash: '0xa7'});

		const rows = await db.prepare(`SELECT key FROM Meta ORDER BY key`).all<{key: string}>();
		expect(rows.results.map((row) => row.key)).toContain(REORG_COUNTER_KEY.absence);
		expect(rows.results.map((row) => row.key)).toContain(REORG_LAST_KEY);
	});

	it('REJECTS on a database with no fixed tables, which is why the fold catches it', async () => {
		// `--no-auto-setup` is the operator saying somebody else migrates this
		// database, so `Meta` may simply not be there. The write must fail loudly
		// enough for `StreamBuilder` to log a miscount -- and the fold must survive it,
		// which `test/equivalence.test.ts` asserts on a running deployment.
		const unmigrated = new RemoteLibSQL(createClient({url: ':memory:'}));
		await expect(recordReorg(unmigrated, {cause: 'absence', blockNumber: 7, blockHash: '0xa7'})).rejects.toThrow();
	});

	it('binds a recorder to ONE handle, so a command cannot count into a database it does not fold into', async () => {
		const db = await freshDatabase();
		const record = reorgRecorderFor(db);

		await record({cause: 'contradiction', blockNumber: 11, blockHash: '0xa11'});

		expect(await readReorgCounters(db)).toMatchObject({contradiction: 1, absence: 0});
	});
});
