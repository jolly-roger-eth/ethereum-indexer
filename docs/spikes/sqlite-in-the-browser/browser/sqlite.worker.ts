/**
 * wasm SQLite in a Worker, hosting the REAL versioned store.
 *
 * The store runs HERE, not on the page, and that is a deliberate design choice
 * rather than a convenience: OPFS sync access handles are Worker-only, so the
 * SQLite route has a worker boundary whatever it does, and the only question is
 * WHERE to put it. Putting the page-worker boundary at the STATEMENT level
 * (page holds the store, worker holds a SQL socket) costs one round-trip per
 * statement and would make the SQLite candidate look absurd for reasons that
 * have nothing to do with SQLite. Putting it at the BLOCK level costs one
 * round-trip per block, which is what a real deployment would do and what the
 * seam already looks like.
 *
 * The price of that choice is visible in the point-read numbers: a read from the
 * page is a `postMessage` round-trip, and no amount of SQL tuning removes it.
 */
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import {VersionedSqlBlockStore, type SqlDatabase, type SqlStatement} from '../src/store/versioned-sql.js';
import type {BlockUpdate, EntityId} from '../src/store/types.js';

type Vfs = 'opfs' | 'opfs-sahpool' | 'memory';

/** `remote-sql` over a synchronous oo1 database. */
class OoStatement implements SqlStatement {
	constructor(
		private db: any,
		private sql: string,
		private args: unknown[] = [],
	) {}
	bind(...values: unknown[]): SqlStatement {
		return new OoStatement(this.db, this.sql, values);
	}
	async all<T = any>(): Promise<{results: T[]}> {
		const results = this.db.exec({
			sql: this.sql,
			bind: this.args.length > 0 ? this.args : undefined,
			rowMode: 'object',
			returnValue: 'resultRows',
		});
		return {results: results as T[]};
	}
}

class OoDatabase implements SqlDatabase {
	constructor(private db: any) {}
	prepare(sql: string): SqlStatement {
		return new OoStatement(this.db, sql);
	}
	/**
	 * ONE transaction per batch, which is what makes a block atomic.
	 * `db.transaction` is synchronous here, so a block never lands half-applied.
	 */
	async batch<T = any>(list: SqlStatement[]): Promise<{results: T[]}[]> {
		const out: {results: T[]}[] = [];
		this.db.transaction(() => {
			for (const statement of list) {
				const inner = statement as unknown as {db: any; sql: string; args: unknown[]};
				const results = this.db.exec({
					sql: inner.sql,
					bind: inner.args.length > 0 ? inner.args : undefined,
					rowMode: 'object',
					returnValue: 'resultRows',
				});
				out.push({results: results as T[]});
			}
		});
		return out;
	}
}

let store: VersionedSqlBlockStore | undefined;
let database: any;
let openedVfs: Vfs = 'memory';

async function openDatabase(vfs: Vfs, filename: string): Promise<{vfs: Vfs; initMs: number; openMs: number}> {
	const initStarted = performance.now();
	const sqlite3 = await sqlite3InitModule({print: () => {}, printErr: () => {}});
	const initMs = performance.now() - initStarted;

	const openStarted = performance.now();
	let used: Vfs = vfs;
	if (vfs === 'opfs' && (sqlite3 as any).oo1?.OpfsDb) {
		database = new (sqlite3 as any).oo1.OpfsDb(`/${filename}`, 'c');
	} else if (vfs === 'opfs-sahpool') {
		const pool = await (sqlite3 as any).installOpfsSAHPoolVfs({name: `pool-${filename}`});
		database = new pool.OpfsSAHPoolDb(`/${filename}`);
	} else {
		// Recorded, never hidden: WebKit under Playwright has no OPFS sync
		// handles, so the SQLite route degrades to a database that does not
		// survive a reload. A number measured here is NOT a persistence number.
		used = 'memory';
		database = new (sqlite3 as any).oo1.DB(`:memory:`, 'c');
	}
	const openMs = performance.now() - openStarted;
	openedVfs = used;
	return {vfs: used, initMs, openMs};
}

self.onmessage = async (event: MessageEvent) => {
	const {id, op, params} = event.data as {id: number; op: string; params: any};
	try {
		let result: unknown;
		switch (op) {
			case 'open': {
				const opened = await openDatabase(params.vfs as Vfs, params.filename as string);
				store = new VersionedSqlBlockStore(`sqlite-${opened.vfs}`, new OoDatabase(database), params.retention);
				const migrateStarted = performance.now();
				await store.open();
				result = {...opened, migrateMs: performance.now() - migrateStarted};
				break;
			}
			case 'applyBlock':
				await store!.applyBlock(params as BlockUpdate);
				result = true;
				break;
			case 'applyBlocks': {
				// The write measurement: the LOOP runs in the worker so that what is
				// timed is storage, not `postMessage`. Every block is still its own
				// `applyBlock`, so it is still one batch per block, and every block is
				// timed on its own so the COST CURVE against dataset size survives.
				const perBlock: number[] = [];
				const started = performance.now();
				for (const update of params.updates as BlockUpdate[]) {
					const blockStarted = performance.now();
					await store!.applyBlock(update);
					perBlock.push(performance.now() - blockStarted);
				}
				result = {ms: performance.now() - started, perBlock};
				break;
			}
			case 'get':
				result = await store!.get(params.entity as string, params.id as EntityId);
				break;
			case 'getMany': {
				const started = performance.now();
				for (const one of params.ids as {entity: string; id: EntityId}[]) await store!.get(one.entity, one.id);
				result = {ms: performance.now() - started};
				break;
			}
			case 'getAsOfMany': {
				const started = performance.now();
				for (const one of params.ids as {entity: string; id: EntityId}[]) {
					await store!.getAsOf(one.entity, one.id, params.blockNumber as number);
				}
				result = {ms: performance.now() - started};
				break;
			}
			case 'revertTo':
				await store!.revertTo(params.blockNumber as number);
				result = true;
				break;
			case 'byteSize':
				result = await store!.byteSize();
				break;
			case 'prune': {
				const started = performance.now();
				await store!.prune(params.floor as number);
				result = {ms: performance.now() - started, bytes: await store!.byteSize()};
				break;
			}
			case 'vfs':
				result = openedVfs;
				break;
			default:
				throw new Error(`unknown op ${op}`);
		}
		(self as unknown as Worker).postMessage({id, result});
	} catch (error) {
		// The message alone is not enough: the sahpool VFS rejects with an error
		// whose `message` is EMPTY on WebKit, so a bare `${error.message}` reports a
		// blank failure and the finding cannot name what went wrong.
		const thrown = error as Error;
		const described =
			[thrown?.name, thrown?.message].filter(Boolean).join(': ') ||
			(typeof error === 'string' ? error : JSON.stringify(error)) ||
			`non-error thrown: ${Object.prototype.toString.call(error)}`;
		(self as unknown as Worker).postMessage({
			id,
			error: `${described}${thrown?.stack ? ` | ${thrown.stack.split('\n')[0]}` : ''}`,
		});
	}
};
