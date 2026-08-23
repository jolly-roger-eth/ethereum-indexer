/**
 * The page-side handle on the SQLite worker.
 *
 * Deliberately thin: it holds no state and does no batching of its own, so the
 * numbers it reports are the worker's, plus exactly one `postMessage`
 * round-trip. The round-trip is not overhead to be optimised away in a
 * benchmark; it is a permanent property of the SQLite route, because the OPFS
 * sync VFS only exists in a Worker.
 */
import type {BlockStore, BlockUpdate, EntityId, Retention} from './types.js';

export type SqliteVfs = 'opfs' | 'opfs-sahpool' | 'memory';

export class SqliteWorkerStore implements BlockStore {
	name: string;
	private worker: Worker;
	private nextId = 1;
	private pending = new Map<number, {resolve: (value: any) => void; reject: (error: Error) => void}>();
	/** What the worker actually got, which is not always what was asked for. */
	vfsUsed: SqliteVfs = 'memory';
	openTimings: {initMs: number; openMs: number; migrateMs: number} | undefined;

	constructor(
		workerUrl: string | URL,
		private vfs: SqliteVfs,
		private filename: string,
		readonly retention: Retention = {kind: 'unbounded'},
	) {
		this.name = `sqlite-${vfs}`;
		this.worker = new Worker(workerUrl, {type: 'module'});
		this.worker.onmessage = (event: MessageEvent) => {
			const {id, result, error} = event.data as {id: number; result?: unknown; error?: string};
			const waiting = this.pending.get(id);
			if (!waiting) return;
			this.pending.delete(id);
			if (error) waiting.reject(new Error(error));
			else waiting.resolve(result);
		};
	}

	private call<T>(op: string, params?: unknown): Promise<T> {
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, {resolve, reject});
			this.worker.postMessage({id, op, params});
		});
	}

	async open(): Promise<void> {
		const opened = await this.call<{vfs: SqliteVfs; initMs: number; openMs: number; migrateMs: number}>('open', {
			vfs: this.vfs,
			filename: this.filename,
			retention: this.retention,
		});
		this.vfsUsed = opened.vfs;
		this.name = `sqlite-${opened.vfs}`;
		this.openTimings = {initMs: opened.initMs, openMs: opened.openMs, migrateMs: opened.migrateMs};
	}

	async close(): Promise<void> {
		this.worker.terminate();
	}

	applyBlock(update: BlockUpdate): Promise<void> {
		return this.call('applyBlock', update);
	}

	/** Time N blocks INSIDE the worker, so the number is storage and not messaging. */
	applyBlocksTimed(updates: BlockUpdate[]): Promise<{ms: number; perBlock: number[]}> {
		return this.call('applyBlocks', {updates});
	}

	get(entity: string, id: EntityId): Promise<Record<string, unknown> | undefined> {
		return this.call('get', {entity, id});
	}

	getManyTimed(ids: {entity: string; id: EntityId}[]): Promise<{ms: number}> {
		return this.call('getMany', {ids});
	}

	getAsOfManyTimed(ids: {entity: string; id: EntityId}[], blockNumber: number): Promise<{ms: number}> {
		return this.call('getAsOfMany', {ids, blockNumber});
	}

	getAsOf(entity: string, id: EntityId, blockNumber: number): Promise<Record<string, unknown> | undefined> {
		return this.call('getAsOf', {entity, id, blockNumber});
	}

	revertTo(blockNumber: number): Promise<void> {
		return this.call('revertTo', {blockNumber});
	}

	byteSize(): Promise<number | undefined> {
		return this.call('byteSize');
	}

	prune(floor: number): Promise<{ms: number; bytes: number | undefined}> {
		return this.call('prune', {floor});
	}
}
