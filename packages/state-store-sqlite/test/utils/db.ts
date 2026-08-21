import {createClient} from '@libsql/client';
import {RemoteLibSQL} from 'remote-sql-libsql';
import type {RemoteSQL, SQLPreparedStatement, SQLResult} from 'remote-sql';

/**
 * A REAL local libSQL/SQLite database behind the `remote-sql` interface.
 *
 * Never a mock: the DELETE-before-re-open ordering (see revert-order.test.ts) is
 * a property of how SQLite enforces a partial unique index, so a fake would
 * happily accept the broken order and the test would prove nothing.
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

/**
 * Wraps a real RemoteSQL and appends a statement that is guaranteed to fail to
 * the END of every batch, so we can observe what a mid-batch failure does to the
 * statements that came before it.
 */
export class FailingTailSQL implements RemoteSQL {
	armed = false;

	constructor(
		private readonly inner: RemoteSQL,
		private readonly failingStatement: {sql: string; args: unknown[]},
	) {}

	prepare(sql: string): SQLPreparedStatement {
		return this.inner.prepare(sql);
	}

	batch<T = any>(list: SQLPreparedStatement[]): Promise<SQLResult<T>[]> {
		if (!this.armed) {
			return this.inner.batch<T>(list);
		}
		const bad = this.inner.prepare(this.failingStatement.sql).bind(...this.failingStatement.args);
		return this.inner.batch<T>([...list, bad]);
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
