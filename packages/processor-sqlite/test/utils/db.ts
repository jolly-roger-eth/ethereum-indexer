import {createClient} from '@libsql/client';
import type {RemoteSQL, SQLPreparedStatement, SQLResult} from 'remote-sql';
import {RemoteLibSQL} from 'remote-sql-libsql';

/**
 * A REAL local libSQL/SQLite database behind the `remote-sql` interface.
 *
 * Never a mock. The properties under test here are properties of an engine: a
 * re-applied block raising a primary-key violation, and the DELETE-before-reopen
 * ordering inside `revertTo` that a partial unique index enforces per statement.
 * A fake would accept both and the tests would prove nothing.
 *
 * Copied from `state-store-sqlite/test/utils/db.ts` rather than imported: a test
 * helper is not part of that package's published surface, and reaching across
 * package boundaries into one would make it one by accident.
 */
export function createTestDB(): RemoteSQL {
	return new RemoteLibSQL(createClient({url: ':memory:'}));
}

/** Wraps a real RemoteSQL, recording every `batch` call for assertions. */
export class RecordingSQL implements RemoteSQL {
	readonly batches: SQLPreparedStatement[][] = [];

	constructor(private readonly inner: RemoteSQL) {}

	prepare(sql: string): SQLPreparedStatement {
		return this.inner.prepare(sql);
	}

	batch<T = any>(list: SQLPreparedStatement[]): Promise<SQLResult<T>[]> {
		this.batches.push(list);
		return this.inner.batch<T>(list);
	}
}

/** Raw read helper for assertions that deliberately bypass the store's API. */
export async function rows<T = any>(db: RemoteSQL, sql: string, ...args: unknown[]): Promise<T[]> {
	const result = await db
		.prepare(sql)
		.bind(...args)
		.all<T>();
	return result.results;
}

/** The `sql` text of a prepared statement, exposed by the libSQL implementation. */
export function sqlOf(statement: SQLPreparedStatement): string {
	return (statement as unknown as {sql: string}).sql;
}
