/**
 * Versioned rows over IndexedDB: the candidate the prior research recommends.
 *
 * Same seam, same trace, same measurements as the SQLite candidate, so the
 * comparison is between STORAGE ENGINES and not between two different designs.
 * Three object stores, and one readwrite transaction per BLOCK:
 *
 *   current   rowKey -> {lower, values}          the tip read, one `get`
 *   versions  [rowKey, lower] -> {upper, values} the history, for as-of
 *   blocks    blockNumber -> {touched}           what to undo, for revert
 *
 * `values: null` in `versions` is a tombstone: a delete opens a version that
 * says "absent from here", which is what makes an as-of read able to say a row
 * did not exist at block N rather than falling through to an older one.
 */
import {
	RetentionUnavailableError,
	rowKey,
	type BlockStore,
	type BlockUpdate,
	type EntityId,
	type Retention,
} from './types.js';

type Touched = {key: string; prevLower: number | null};

function request<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

function done(tx: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
	});
}

export class IdbBlockStore implements BlockStore {
	readonly name: string;
	private db: IDBDatabase | undefined;
	private tip = 0;
	/**
	 * The live set, held in memory, when `cacheCurrent` is on.
	 *
	 * This is the CONTROL for the write measurement. Without it, applying a block
	 * reads every row it is about to write, so a slowdown as the store grows could
	 * be the read or the write and the number cannot say which. With it, the reads
	 * are gone and what is left is purely IndexedDB's write path. It is also not a
	 * fantasy: the prior research's whole premise is a SMALL live set, and a store
	 * that fits in memory can legitimately keep it there (the incumbent already
	 * does, since its state IS an in-memory object).
	 */
	private cache: Map<string, {lower: number; values: unknown}> | undefined;

	constructor(
		private dbName: string,
		readonly retention: Retention = {kind: 'unbounded'},
		name = 'idb-versioned',
		private cacheCurrent = false,
	) {
		this.name = name;
	}

	async open(): Promise<void> {
		this.db = await new Promise<IDBDatabase>((resolve, reject) => {
			const req = indexedDB.open(this.dbName, 1);
			req.onupgradeneeded = () => {
				const db = req.result;
				if (!db.objectStoreNames.contains('current')) db.createObjectStore('current');
				if (!db.objectStoreNames.contains('versions')) db.createObjectStore('versions');
				if (!db.objectStoreNames.contains('blocks')) db.createObjectStore('blocks');
			};
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
		if (this.cacheCurrent) {
			// Warming the cache IS part of this variant's cold start, and it grows
			// with the live set, so it is paid inside `open` where it is measured.
			const {stores} = this.store(['current'], 'readonly');
			const keys = (await request(stores[0].getAllKeys())) as string[];
			const values = (await request(stores[0].getAll())) as {lower: number; values: unknown}[];
			this.cache = new Map(keys.map((key, index) => [key, values[index]]));
		}
	}

	async close(): Promise<void> {
		this.db?.close();
		this.db = undefined;
	}

	private store(names: string[], mode: IDBTransactionMode): {tx: IDBTransaction; stores: IDBObjectStore[]} {
		if (!this.db) throw new Error(`${this.name}: not open`);
		const tx = this.db.transaction(names, mode);
		return {tx, stores: names.map((name) => tx.objectStore(name))};
	}

	/** ONE block, ONE transaction. Splitting it would be measuring a shape the indexer never emits. */
	async applyBlock(update: BlockUpdate): Promise<void> {
		const {tx, stores} = this.store(['current', 'versions', 'blocks'], 'readwrite');
		const [current, versions, blocks] = stores;
		const touched: Touched[] = [];

		for (const mutation of update.mutations) {
			const key = rowKey(mutation.entity, mutation.id);
			const previous = this.cache
				? this.cache.get(key)
				: ((await request(current.get(key))) as {lower: number; values: unknown} | undefined);
			if (this.cache) {
				if (mutation.type === 'upsert') this.cache.set(key, {lower: update.block.number, values: mutation.values});
				else this.cache.delete(key);
			}
			if (previous) {
				versions.put({upper: update.block.number, values: previous.values}, [key, previous.lower]);
			}
			if (mutation.type === 'upsert') {
				current.put({lower: update.block.number, values: mutation.values}, key);
				versions.put({upper: null, values: mutation.values}, [key, update.block.number]);
			} else {
				if (!previous) continue; // deleting what was never there is a no-op
				current.delete(key);
				versions.put({upper: null, values: null}, [key, update.block.number]);
			}
			touched.push({key, prevLower: previous ? previous.lower : null});
		}

		blocks.put({touched}, update.block.number);
		await done(tx);
		this.tip = update.block.number;
	}

	async get(entity: string, id: EntityId): Promise<Record<string, unknown> | undefined> {
		const key = rowKey(entity, id);
		if (this.cache) return this.cache.get(key)?.values as Record<string, unknown> | undefined;
		const {stores} = this.store(['current'], 'readonly');
		const row = (await request(stores[0].get(key))) as {values: Record<string, unknown>} | undefined;
		return row?.values;
	}

	async getAsOf(entity: string, id: EntityId, blockNumber: number): Promise<Record<string, unknown> | undefined> {
		if (this.retention.kind === 'revert-only' && blockNumber < this.tip) {
			throw new RetentionUnavailableError(this.name, blockNumber, this.retention);
		}
		if (this.retention.kind === 'window' && blockNumber < this.tip - this.retention.blocks) {
			throw new RetentionUnavailableError(this.name, blockNumber, this.retention);
		}
		const key = rowKey(entity, id);
		const {stores} = this.store(['versions'], 'readonly');
		// The greatest `lower` at or below the block asked for: one index seek,
		// backwards, first hit wins.
		const range = IDBKeyRange.bound([key], [key, blockNumber]);
		const cursor = await new Promise<IDBCursorWithValue | null>((resolve, reject) => {
			const req = stores[0].openCursor(range, 'prev');
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
		if (!cursor) return undefined;
		const version = cursor.value as {upper: number | null; values: Record<string, unknown> | null};
		if (version.upper !== null && version.upper <= blockNumber) return undefined;
		return version.values ?? undefined;
	}

	async revertTo(blockNumber: number): Promise<void> {
		const above = IDBKeyRange.lowerBound(blockNumber, true);

		// Read what has to be undone first, in its own transaction. A cursor walk
		// interleaved with awaited reads is the shape that silently auto-commits a
		// transaction mid-iteration, and a half-reverted store is the worst possible
		// outcome of a reorg.
		const {stores: readStores} = this.store(['blocks'], 'readonly');
		const numbers = (await request(readStores[0].getAllKeys(above))) as number[];
		const entries = (await request(readStores[0].getAll(above))) as {touched: Touched[]}[];
		const toUndo = numbers
			.map((number, index) => ({number, touched: entries[index].touched}))
			.sort((a, b) => b.number - a.number);

		const {tx, stores} = this.store(['current', 'versions', 'blocks'], 'readwrite');
		const [current, versions, blocks] = stores;
		for (const {number, touched} of toUndo) {
			for (const entry of touched) {
				versions.delete([entry.key, number]);
				if (entry.prevLower === null) {
					current.delete(entry.key);
					this.cache?.delete(entry.key);
					continue;
				}
				const previous = (await request(versions.get([entry.key, entry.prevLower]))) as
					| {upper: number | null; values: Record<string, unknown> | null}
					| undefined;
				if (!previous) continue;
				versions.put({upper: null, values: previous.values}, [entry.key, entry.prevLower]);
				if (previous.values === null) current.delete(entry.key);
				else current.put({lower: entry.prevLower, values: previous.values}, entry.key);
				if (this.cache) {
					if (previous.values === null) this.cache.delete(entry.key);
					else this.cache.set(entry.key, {lower: entry.prevLower, values: previous.values});
				}
			}
			blocks.delete(number);
		}
		await done(tx);
		this.tip = blockNumber;
	}

	/** Drop versions that closed below the retention floor. The footprint measurement. */
	async prune(floor: number): Promise<number> {
		const {tx, stores} = this.store(['versions'], 'readwrite');
		let dropped = 0;
		await new Promise<void>((resolve, reject) => {
			const req = stores[0].openCursor();
			req.onsuccess = () => {
				const cursor = req.result;
				if (!cursor) return resolve();
				const version = cursor.value as {upper: number | null};
				if (version.upper !== null && version.upper <= floor) {
					cursor.delete();
					dropped++;
				}
				cursor.continue();
			};
			req.onerror = () => reject(req.error);
		});
		await done(tx);
		return dropped;
	}

	async counts(): Promise<{current: number; versions: number; blocks: number}> {
		const {stores} = this.store(['current', 'versions', 'blocks'], 'readonly');
		return {
			current: await request(stores[0].count()),
			versions: await request(stores[1].count()),
			blocks: await request(stores[2].count()),
		};
	}
}

/** Delete a database, so a run starts cold. */
export function deleteDatabase(name: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.deleteDatabase(name);
		req.onsuccess = () => resolve();
		req.onerror = () => reject(req.error);
		req.onblocked = () => resolve();
	});
}
