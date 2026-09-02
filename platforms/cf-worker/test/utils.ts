import {env, createExecutionContext, waitOnExecutionContext} from 'cloudflare:test';
import type {RemoteSQL, SQLPreparedStatement, SQLResult} from 'remote-sql';
import worker from '../src/worker.js';

export async function fetchWorker(req: string, init?: RequestInit): Promise<Response> {
	const url = req.startsWith('http') ? req : `http://example.com${req.startsWith('/') ? req : `/${req}`}`;
	const request = new Request(url, init);
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

/** What one request actually carried: the SQL text and the values bound to it. */
export type RecordedStatement = {sql: string; args: unknown[]};

/**
 * Wraps a REAL `RemoteSQL` (here a D1 binding) and records what every request
 * carried, so a test can count bound parameters and queries.
 *
 * The counting is where the value is. D1's caps are per QUERY (bound parameters)
 * and per INVOCATION (queries), and neither is observable from a result: a
 * statement that is one parameter over comes back as a rejection naming nothing
 * useful, and an invocation that is one query over fails somewhere else
 * entirely. Recording at the `remote-sql` seam asserts both where they are
 * decided rather than where they are punished, and `queries` counts a batch of N
 * statements as N queries, which is the pessimistic reading D1's documentation
 * leaves open.
 */
export class RecordingSQL implements RemoteSQL {
	readonly batches: RecordedStatement[][] = [];
	readonly selects: RecordedStatement[] = [];

	constructor(private readonly inner: RemoteSQL) {}

	/** Every statement issued, batched or not. */
	statements(): RecordedStatement[] {
		return [...this.selects, ...this.batches.flat()];
	}

	/** Queries this handle has issued, counted the way D1 might charge them. */
	get queries(): number {
		return this.statements().length;
	}

	reset(): void {
		this.batches.length = 0;
		this.selects.length = 0;
	}

	prepare(sql: string): SQLPreparedStatement {
		return new RecordingStatement(this, this.inner.prepare(sql), sql, []);
	}

	batch<T = any>(list: SQLPreparedStatement[]): Promise<SQLResult<T>[]> {
		this.batches.push(list.map((statement) => recordOf(statement)));
		return this.inner.batch<T>(list.map((statement) => unwrap(statement)));
	}
}

class RecordingStatement implements SQLPreparedStatement {
	constructor(
		private readonly recorder: RecordingSQL,
		readonly inner: SQLPreparedStatement,
		readonly sql: string,
		readonly args: unknown[],
	) {}

	bind(...values: unknown[]): SQLPreparedStatement {
		return new RecordingStatement(this.recorder, this.inner.bind(...values), this.sql, values);
	}

	all<T = any>(): Promise<SQLResult<T>> {
		this.recorder.selects.push({sql: this.sql, args: this.args});
		return this.inner.all<T>();
	}
}

function recordOf(statement: SQLPreparedStatement): RecordedStatement {
	if (statement instanceof RecordingStatement) return {sql: statement.sql, args: statement.args};
	throw new Error('a statement reached batch() without going through this handle');
}

function unwrap(statement: SQLPreparedStatement): SQLPreparedStatement {
	return statement instanceof RecordingStatement ? statement.inner : statement;
}
