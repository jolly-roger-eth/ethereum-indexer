/**
 * The INCUMBENT: the whole state, written to IndexedDB on every save.
 *
 * This is what `@etherfold/browser`'s `keepStateOnIndexedDB` does today
 * (`set(storageID, {...all})` through `idb-keyval`), and it is the thing the
 * comparison is really against: whichever row-level backend wins has to beat
 * THIS to be worth building, and this is the one that gets slower as state
 * grows rather than as the block grows.
 *
 * Two variants are measured because both exist in the codebase: the browser
 * keeper hands the live object to `idb-keyval` (structured clone), while the fs
 * and CLI keepers `JSON.stringify` it.
 *
 * Two honesties about this measurement:
 *   - the real keeper also stores `lastSync` and the immer patch history
 *     alongside the state, so what is measured here is a LOWER BOUND on the
 *     incumbent's per-save cost;
 *   - it retains nothing. It cannot answer an as-of read at all, and it does
 *     not pretend to: `getAsOf` refuses.
 */
import {set as idbSet, get as idbGet, del as idbDel, createStore, type UseStore} from 'idb-keyval';
import {rowKey, RetentionUnavailableError, type BlockStore, type BlockUpdate, type EntityId, type Retention} from './types.js';

export type BlobEncoding = 'structured-clone' | 'json';

export class BlobBlockStore implements BlockStore {
	readonly name: string;
	readonly retention: Retention = {kind: 'revert-only'};
	private state: Record<string, Record<string, unknown>> = {};
	private store: UseStore | undefined;
	private tip = 0;
	/** Bytes of the last serialisation, for the footprint-versus-state-size curve. */
	lastBytes = 0;

	constructor(
		private dbName: string,
		private encoding: BlobEncoding = 'structured-clone',
	) {
		this.name = `blob-${encoding}`;
	}

	async open(): Promise<void> {
		this.store = createStore(this.dbName, 'keyval');
		this.state = {};
	}

	async close(): Promise<void> {}

	/**
	 * The whole state goes out on every block, which is the point: the write is
	 * O(total state), not O(what changed).
	 */
	async applyBlock(update: BlockUpdate): Promise<void> {
		for (const mutation of update.mutations) {
			const key = rowKey(mutation.entity, mutation.id);
			if (mutation.type === 'upsert') this.state[key] = mutation.values;
			else delete this.state[key];
		}
		const all = {state: this.state, lastSync: {lastToBlock: update.block.number}};
		if (this.encoding === 'json') {
			const text = JSON.stringify(all);
			this.lastBytes = text.length;
			await idbSet('state', text, this.store);
		} else {
			await idbSet('state', all, this.store);
		}
		this.tip = update.block.number;
	}

	async get(entity: string, id: EntityId): Promise<Record<string, unknown> | undefined> {
		return this.state[rowKey(entity, id)];
	}

	async getAsOf(entity: string, id: EntityId, blockNumber: number): Promise<Record<string, unknown> | undefined> {
		if (blockNumber < this.tip) throw new RetentionUnavailableError(this.name, blockNumber, this.retention);
		return this.get(entity, id);
	}

	/** The incumbent has no undo of its own: a reorg re-indexes, or restores a blob. */
	async revertTo(): Promise<void> {
		throw new Error(`${this.name} cannot revert: it keeps no history`);
	}

	/** A cold start: read the blob back and rebuild the in-memory state. */
	async load(): Promise<number> {
		const stored = await idbGet('state', this.store);
		if (!stored) return 0;
		const all = this.encoding === 'json' ? JSON.parse(stored as string) : stored;
		this.state = all.state;
		return Object.keys(this.state).length;
	}

	async clear(): Promise<void> {
		await idbDel('state', this.store);
	}

	rowCount(): number {
		return Object.keys(this.state).length;
	}
}
