import {
	assertListingLimit,
	assertRetained,
	boundedListing,
	idValues,
	mustGet,
	normalizeBlockHash,
	normalizeEntities,
	pruneBudget,
	resolveRetention,
	retentionFloor,
	type BlockPointer,
	type EntityDeclaration,
	type EntityId,
	type EntityIdPrefix,
	type Listing,
	type Mutation,
	type NormalizedEntity,
	type PruneOptions,
	type PruneReport,
	type Retention,
	type RetentionOptions,
	type RetentionSetting,
	type StateStore,
	type StateStoreCapabilities,
	type CursorWrite,
} from '@etherfold/state-store';
import {committed, openDatabase, request, walk} from './idb.js';
import {
	above,
	asOfRange,
	BLOCKS,
	CURRENT,
	CURSORS,
	HASH_INDEX,
	listingRange,
	LOWER_INDEX,
	rowKey,
	rowOfVersionKey,
	SCHEMA_VERSION,
	UPPER_INDEX,
	versionKey,
	VERSIONS,
	type BlockRecord,
	type CurrentRecord,
	type VersionRecord,
} from './keys.js';

/** The database a store opens when the host does not name one. */
export const DEFAULT_DATABASE_NAME = 'etherfold-state';

export type IndexedDBStateStoreOptions = RetentionOptions & {
	/**
	 * The IndexedDB database to keep this state in. Defaults to
	 * `etherfold-state`.
	 *
	 * It is the identity of the state, so two stores sharing a name are ONE store
	 * (which is what makes several tabs of one app work) and two UNRELATED
	 * indexers sharing a name would write into each other. An origin running more
	 * than one processor names them apart here.
	 */
	readonly databaseName?: string;
	/**
	 * What the deployment asks this store to keep. Defaults to `unbounded`.
	 *
	 * Validated at construction rather than at the first read it would have
	 * answered wrongly: a window below the finality depth is refused here, naming
	 * both numbers. What is set is what gets REPORTED, because this store enforces
	 * both halves of it: a read outside the window is refused, and `prune` drops
	 * the versions the window no longer covers.
	 */
	readonly retention?: RetentionSetting;
	/**
	 * The IndexedDB implementation to open the database through. Defaults to the
	 * global one.
	 *
	 * For a test running under `fake-indexeddb`, or a host that has its own
	 * factory. It is not a way to make this store work off a browser: the point of
	 * this backend is the engine underneath it.
	 */
	readonly indexedDB?: IDBFactory;
};

/**
 * Entity state as versioned rows in IndexedDB: the browser backend.
 *
 * Every version of every entity is a record carrying `lower` (valid from,
 * inclusive) and `upper` (valid until, exclusive; `null` means live), exactly as
 * `@etherfold/state-store-sqlite` keeps them as columns, so "the state at block
 * N" is a key range rather than a replay and a reorg is two range scans rather
 * than an undo log. The declaration is `{name, id, fields}` and the store owns
 * everything else.
 *
 * ## Why IndexedDB, and what would change the answer
 *
 * Measured, not preferred: on the real workload (the launched stratagems game on
 * Base) IndexedDB beat wasm SQLite on writes by 1.6x to 6.9x and on reads by 4x
 * to 14x, on every engine that can run both, and WebKit cannot run the SQLite
 * route at all. The four things that would have to be true at once for the
 * answer to change, and the five things that would overturn it, are in
 * **ADR-0024**, from `work/notes/findings/sqlite-in-the-browser.md`.
 *
 * What this is NOT is a speed-up over the incumbent whole-state blob
 * (`keepStateOnIndexedDB`), which is the FASTEST writer at today's sizes (2.0
 * ms/block on Chromium against 45.6 for row-level writes at 4,072 live rows).
 * What row-level writes buy is history, reorg revert, a cold start that reads
 * only what it needs, and a write cost proportional to what CHANGED rather than
 * to total state. Sold as a speed-up, the first benchmark contradicts it.
 *
 * ## Two rules this implementation lives by
 *
 * **One block is one transaction**, so a block applies whole or not at all, and
 * two tabs writing the same database serialise instead of interleaving.
 *
 * **Inside a transaction, await only IndexedDB.** A promise resolved from an
 * IndexedDB event continues in the same microtask checkpoint and the transaction
 * is still active; anything else lets it auto-commit under code that thinks it
 * still owns it. See `idb.ts`.
 */
export class IndexedDBStateStore implements StateStore {
	readonly databaseName: string;
	private readonly entities: ReadonlyMap<string, NormalizedEntity>;
	private readonly provided: Retention;
	private readonly finalityDepth: number | undefined;
	private readonly factory: IDBFactory | undefined;
	private connection: Promise<IDBDatabase> | undefined;

	constructor(declarations: Iterable<EntityDeclaration>, options: IndexedDBStateStoreOptions = {}) {
		this.entities = normalizeEntities(declarations);
		// resolved at CONSTRUCTION: a retention below the finality floor is a
		// configuration error, and it should land where it was configured rather
		// than on the first read that would have been served wrongly.
		this.provided = resolveRetention(options.retention, options);
		this.finalityDepth = options.finalityDepth;
		this.databaseName = options.databaseName ?? DEFAULT_DATABASE_NAME;
		this.factory = options.indexedDB;
	}

	get declarations(): ReadonlyMap<string, NormalizedEntity> {
		return this.entities;
	}

	/**
	 * What was configured, because this store enforces all of it.
	 *
	 * `unbounded` by default. A window is reported as a window: reads outside it
	 * are refused by `getAsOf` / `listAsOf` at all times, and `prune` drops the
	 * versions it no longer covers. `revert-only` refuses every historical read
	 * while `revertTo` keeps working.
	 *
	 * Readable before `migrate`, and before the database is even opened, which is
	 * the point of a capability report: a caller learns what history it can have
	 * at startup rather than from a wrong answer later.
	 */
	get capabilities(): StateStoreCapabilities {
		return {retention: this.provided, asOf: this.provided.kind !== 'revert-only'};
	}

	/**
	 * Open the database, creating the object stores and indexes the first time.
	 *
	 * Idempotent and safe on every boot: the schema is FIXED (see `keys.ts`), so
	 * declaring another entity is not a migration here and cannot be blocked by a
	 * second open tab.
	 */
	async migrate(): Promise<void> {
		await this.database();
	}

	/**
	 * Close the connection.
	 *
	 * Not part of the seam, and needed anyway: a browser cannot delete a database
	 * while a connection is open, and a test that leaves one open blocks the next
	 * one. The store reopens on the next call.
	 */
	async close(): Promise<void> {
		const connection = this.connection;
		this.connection = undefined;
		if (connection) (await connection).close();
	}

	/**
	 * Apply one block: the block record plus every mutation, as ONE transaction.
	 *
	 * Every mutation is resolved against the declarations BEFORE the transaction
	 * is opened, so a mutation naming an entity that was never declared leaves the
	 * store exactly as it found it and leaves the block's height free.
	 *
	 * Re-applying a height, or a second hash claiming one, is refused rather than
	 * written: two versions of one business key open at once is a state every
	 * later read would have to pick between. A reorged height is REVERTED and then
	 * re-applied.
	 *
	 * Two mutations of ONE business key in one block resolve to the last of them,
	 * because a version is keyed by `(id, lower)` and a block opens at most one
	 * version per key here. The SQL backend keeps both (its version identity is a
	 * surrogate row id) and the extra one is a zero-width version no read can ever
	 * return, so the two backends answer identically; they differ only in what they
	 * store. `MutationContext` coalesces per business key anyway, so this is only
	 * reachable by calling `applyBlock` directly.
	 *
	 * The optional `cursor` is written inside that same transaction, which is the
	 * point of the cursor living behind the seam at all: the block and the record
	 * of having reached it commit together or neither does. See `cursor.ts`.
	 */
	async applyBlock(block: BlockPointer, mutations: readonly Mutation[] = [], cursor?: CursorWrite): Promise<void> {
		const hash = normalizeBlockHash(block.hash);
		const planned = mutations.map((mutation) => {
			const entity = mustGet(this.entities, mutation.entity);
			return {mutation, entity, key: rowKey(entity, mutation.id), id: idValues(entity, mutation.id)};
		});

		const db = await this.database();
		const tx = db.transaction([CURRENT, VERSIONS, BLOCKS, CURSORS], 'readwrite');
		const current = tx.objectStore(CURRENT);
		const versions = tx.objectStore(VERSIONS);
		const blocks = tx.objectStore(BLOCKS);
		const settled = committed(tx);

		const recorded = (await request(blocks.get(block.number))) as BlockRecord | undefined;
		if (recorded) {
			throw abort(
				tx,
				settled,
				`block ${block.number} is already recorded: applying the same block twice is a caller bug, ` +
					`and a reorged height must be reverted before its replacement is applied.`,
			);
		}
		const claimed = await request(blocks.index(HASH_INDEX).getKey(hash));
		if (claimed !== undefined) {
			throw abort(tx, settled, `block hash ${hash} is already recorded, at height ${String(claimed)}.`);
		}

		for (const {mutation, entity, key, id} of planned) {
			const previous = (await request(current.get(key))) as CurrentRecord | undefined;
			// close the live version AT this block: the range is half-open, so the
			// version that was live is readable as of every block below this one.
			if (previous) {
				versions.put(
					{lower: previous.lower, upper: block.number, values: previous.values},
					versionKey(key, previous.lower),
				);
			}
			if (mutation.type === 'upsert') {
				const values = completeRow(entity, id, mutation.values);
				current.put({lower: block.number, values}, key);
				versions.put({lower: block.number, upper: null, values}, versionKey(key, block.number));
			} else if (previous) {
				// a delete is ONLY the close: no version is opened, so the entity is
				// absent from this block onward and fully readable as of any earlier one.
				current.delete(key);
			}
		}

		blocks.put({number: block.number, hash, timestamp: block.timestamp} satisfies BlockRecord);
		if (cursor) tx.objectStore(CURSORS).put(cursor.value, cursor.key);
		await settled;
	}

	/** The opaque string last written under `key`, or `undefined`. See `cursor.ts`. */
	async readCursor(key: string): Promise<string | undefined> {
		const db = await this.database();
		const store = db.transaction(CURSORS, 'readonly').objectStore(CURSORS);
		return (await request(store.get(key))) as string | undefined;
	}

	/** Move a cursor with no block behind it. See `StateStore.writeCursor`. */
	async writeCursor(key: string, value: string): Promise<void> {
		const db = await this.database();
		const tx = db.transaction(CURSORS, 'readwrite');
		const settled = committed(tx);
		tx.objectStore(CURSORS).put(value, key);
		await settled;
	}

	/** Forget it. Deleting a key that is not there is the no-op the contract asks for. */
	async clearCursor(key: string): Promise<void> {
		const db = await this.database();
		const tx = db.transaction(CURSORS, 'readwrite');
		const settled = committed(tx);
		tx.objectStore(CURSORS).delete(key);
		await settled;
	}

	/** One entity as it stands at the tip: one `get` against the live set. */
	async getCurrent<T = Record<string, unknown>>(entity: string, id: EntityId): Promise<T | undefined> {
		const declaration = mustGet(this.entities, entity);
		const db = await this.database();
		const store = db.transaction(CURRENT, 'readonly').objectStore(CURRENT);
		const record = (await request(store.get(rowKey(declaration, id)))) as CurrentRecord | undefined;
		return record && ({...record.values, _lower: record.lower, _upper: null} as T);
	}

	/**
	 * One entity as of a block number, or a refusal.
	 *
	 * The refusal is the seam's (`assertRetained`) and it comes BEFORE the read: a
	 * historical read this store's declared retention does not cover throws rather
	 * than answering, because an as-of read quietly served from the tip is a
	 * plausible wrong number nothing downstream can tell apart from a true one.
	 *
	 * The read itself is one cursor walked BACKWARDS over the versions of this
	 * business key that opened at or before the block asked about: the first hit
	 * is the newest of them, and it is the answer unless it had already been
	 * closed by then.
	 */
	async getAsOf<T = Record<string, unknown>>(entity: string, id: EntityId, at: number): Promise<T | undefined> {
		const declaration = mustGet(this.entities, entity);
		await assertRetained(this.capabilities, at, () => this.tipBlockNumber());
		const db = await this.database();
		const store = db.transaction(VERSIONS, 'readonly').objectStore(VERSIONS);
		const cursor = await request(store.openCursor(asOfRange(rowKey(declaration, id), at), 'prev'));
		if (!cursor) return undefined;
		const version = cursor.value as VersionRecord;
		if (version.upper !== null && version.upper <= at) return undefined;
		return {...version.values, _lower: version.lower, _upper: version.upper} as T;
	}

	/**
	 * The children of an id PREFIX at the tip: one `IDBKeyRange` cursor over the
	 * live set, bounded by the limit.
	 *
	 * The range is `bound([entity, ...prefix], [entity, ...prefix, []])`, which is
	 * every key starting with the prefix and nothing else, so this is an indexed
	 * range scan and never a scan with a filter over it. That is the whole reason
	 * the seam's only set read has this exact shape (ADR-0021), and it is asserted
	 * rather than assumed in `test/listing-access-path.test.ts`.
	 */
	async listCurrent<T = Record<string, unknown>>(
		entity: string,
		prefix: EntityIdPrefix,
		limit: number,
	): Promise<Listing<T>> {
		const declaration = mustGet(this.entities, entity);
		const range = listingRange(declaration, prefix);
		assertListingLimit(declaration, limit);

		const db = await this.database();
		const store = db.transaction(CURRENT, 'readonly').objectStore(CURRENT);
		const rows: T[] = [];
		// one MORE than the limit, which is how `truncated` is a fact rather than a
		// guess a caller has to make from `rows.length`.
		await walk(store.openCursor(range), (cursor) => {
			const record = cursor.value as CurrentRecord;
			rows.push({...record.values, _lower: record.lower, _upper: null} as T);
			return rows.length > limit ? 'stop' : 'continue';
		});
		return boundedListing(rows, limit);
	}

	/**
	 * The same listing as of a block number: the children that were live THEN.
	 *
	 * The same range over the VERSIONS, which are ordered by `[entity, ...id,
	 * lower]`, so the versions of one row arrive together and in the order they
	 * opened. At most one of them is live at the block asked about, so the walk
	 * emits at most one row per business key and does it in ascending id order
	 * without sorting anything.
	 */
	async listAsOf<T = Record<string, unknown>>(
		entity: string,
		prefix: EntityIdPrefix,
		at: number,
		limit: number,
	): Promise<Listing<T>> {
		const declaration = mustGet(this.entities, entity);
		const range = listingRange(declaration, prefix);
		assertListingLimit(declaration, limit);
		await assertRetained(this.capabilities, at, () => this.tipBlockNumber());

		const db = await this.database();
		const store = db.transaction(VERSIONS, 'readonly').objectStore(VERSIONS);
		const rows: T[] = [];
		await walk(store.openCursor(range), (cursor) => {
			const version = cursor.value as VersionRecord;
			if (version.lower <= at && (version.upper === null || at < version.upper)) {
				rows.push({...version.values, _lower: version.lower, _upper: version.upper} as T);
				if (rows.length > limit) return 'stop';
			}
			return 'continue';
		});
		return boundedListing(rows, limit);
	}

	/**
	 * Roll the state back to `keepUpTo`: the SQL backend's two moves, as two
	 * index range scans.
	 *
	 * Leg A drops the versions the dead branch OPENED (`lower` above the fork).
	 * Leg B re-opens the versions it CLOSED (`upper` above the fork), which is
	 * what makes a counter a reorged block incremented go back DOWN, and what
	 * brings back a row a reorged block deleted.
	 *
	 * The order is load-bearing: a version the dead branch closed can only become
	 * live again once the dead branch's own version is gone, or two versions of
	 * one business key would be open at once. Both legs also fix the live set as
	 * they go, so the tip read and the tip listing see the reverted state rather
	 * than a stale copy of the dead branch.
	 *
	 * There is deliberately no undo journal per block. The two indexes already
	 * say exactly which versions are above the fork, so a revert costs what it
	 * touches, and a journal would be a second description of the same fact that
	 * grows with every mutation ever applied.
	 */
	async revertTo(keepUpTo: number): Promise<void> {
		// `CURSORS` is deliberately not in this transaction: how far the CALLER got is
		// not entity state, and the caller moves it when it applies the canonical
		// branch. See `cursor.ts`.
		const db = await this.database();
		const tx = db.transaction([CURRENT, VERSIONS, BLOCKS], 'readwrite');
		const current = tx.objectStore(CURRENT);
		const versions = tx.objectStore(VERSIONS);
		const blocks = tx.objectStore(BLOCKS);
		const settled = committed(tx);

		await walk(versions.index(LOWER_INDEX).openCursor(above(keepUpTo)), (cursor) => {
			current.delete(rowOfVersionKey(cursor.primaryKey as IDBValidKey[]));
			cursor.delete();
			return 'continue';
		});

		await walk(versions.index(UPPER_INDEX).openCursor(above(keepUpTo)), (cursor) => {
			const version = cursor.value as VersionRecord;
			cursor.update({...version, upper: null} satisfies VersionRecord);
			current.put(
				{lower: version.lower, values: version.values} satisfies CurrentRecord,
				rowOfVersionKey(cursor.primaryKey as IDBValidKey[]),
			);
			return 'continue';
		});

		blocks.delete(above(keepUpTo));
		await settled;
	}

	/**
	 * Delete the versions the retention floor puts out of reach, oldest close
	 * first, and report what went.
	 *
	 * The predicate is the seam's (`retentionFloor`) and the access path is this
	 * backend's: the `upper` index holds exactly the CLOSED versions, ordered by
	 * the block that closed them, because a live version's `upper` is `null` and
	 * `null` is not a valid IndexedDB key. So the LIVE version of an entity --
	 * the current state, however old, which is the row a prune written as "drop
	 * what is older than the floor" destroys -- cannot be reached from here at
	 * all, and the pass is a range scan rather than the full scan the spike's
	 * prototype used (6.3 s at 62,553 versions in the finding).
	 *
	 * Oldest first matters when a budget stops the pass: what survives a partial
	 * prune is the newest of the unreachable versions, so the store converges
	 * towards the window from the far end rather than leaving arbitrary holes.
	 *
	 * It never touches the block records. They are three fields each, they are
	 * what makes re-applying a height raise, and dropping them would turn "that
	 * block is outside what I keep" into "there is no such block", which is a
	 * worse answer and, for a consumer that pinned the hash, a wrong one.
	 */
	async prune(options: PruneOptions = {}): Promise<PruneReport> {
		const budget = pruneBudget(options);
		const tip = await this.tipBlockNumber();
		const floor = tip === undefined ? undefined : retentionFloor(this.provided, tip, this.finalityDepth);
		if (floor === undefined) return {tip, floor: undefined, versionsDeleted: 0, complete: true};

		const db = await this.database();
		const tx = db.transaction(VERSIONS, 'readwrite');
		const versions = tx.objectStore(VERSIONS);
		const settled = committed(tx);
		let versionsDeleted = 0;
		await walk(versions.index(UPPER_INDEX).openCursor(IDBKeyRange.upperBound(floor)), (cursor) => {
			cursor.delete();
			versionsDeleted++;
			return versionsDeleted >= budget ? 'stop' : 'continue';
		});
		await settled;

		// Without a budget the range was drained, so the pass is complete by
		// construction. With one, whether anything is left is a question only the
		// database can answer, and one bounded probe is cheaper than making the
		// caller guess.
		const complete = versionsDeleted < budget || !(await this.hasPrunableVersions(floor));
		return {tip, floor, versionsDeleted, complete};
	}

	/**
	 * The block recorded at a height, or `undefined`.
	 *
	 * Not part of `StateStore`: addressing state by hash or by time (and refusing
	 * an address that resolves to nothing) is the read layer above the seam. This
	 * is here so a caller, or a test, can see what was recorded.
	 */
	async getBlock(number: number): Promise<BlockRecord | undefined> {
		const db = await this.database();
		const store = db.transaction(BLOCKS, 'readonly').objectStore(BLOCKS);
		return (await request(store.get(number))) as BlockRecord | undefined;
	}

	// -- internals -----------------------------------------------------------

	/**
	 * The highest recorded block, or `undefined` before the first one is applied.
	 *
	 * Read from the database every time rather than cached, and that is the
	 * multi-tab decision showing up in the smallest place: another tab may have
	 * moved the tip since this one last wrote, and a retention window is a
	 * distance from it, so a cached tip would refuse reads that are inside the
	 * window (or answer ones that are not). It is only ever read when a WINDOW is
	 * claimed, because `assertRetained` takes it as a thunk.
	 */
	private async tipBlockNumber(): Promise<number | undefined> {
		const db = await this.database();
		const store = db.transaction(BLOCKS, 'readonly').objectStore(BLOCKS);
		const cursor = await request(store.openCursor(null, 'prev'));
		return cursor ? (cursor.key as number) : undefined;
	}

	/** Whether any version is still unreachable at `floor`: one bounded probe. */
	private async hasPrunableVersions(floor: number): Promise<boolean> {
		const db = await this.database();
		const store = db.transaction(VERSIONS, 'readonly').objectStore(VERSIONS);
		const cursor = await request(store.index(UPPER_INDEX).openCursor(IDBKeyRange.upperBound(floor)));
		return cursor !== null;
	}

	/**
	 * The one connection, opened on first use and reused.
	 *
	 * A failed open does not poison the store: the promise is dropped so the next
	 * call tries again, which is what a tab that was denied storage and then
	 * granted it needs.
	 */
	private database(): Promise<IDBDatabase> {
		if (!this.connection) {
			const factory = this.factory ?? (globalThis as {indexedDB?: IDBFactory}).indexedDB;
			if (!factory) {
				return Promise.reject(
					new Error(
						`no IndexedDB in this environment: @etherfold/state-store-indexeddb is the BROWSER backend. On a ` +
							`server use @etherfold/state-store-sqlite, in a test either MemoryStateStore (the seam's reference ` +
							`store) or fake-indexeddb, or pass your own factory as \`indexedDB\`.`,
					),
				);
			}
			this.connection = openDatabase(this.databaseName, SCHEMA_VERSION, upgrade, factory).catch((error) => {
				this.connection = undefined;
				throw error;
			});
		}
		return this.connection;
	}
}

/**
 * Create the fixed schema, and add whatever a newer version of this package
 * introduced.
 *
 * The version is this PACKAGE's and never a processor's: the object stores do not
 * depend on the declarations (`keys.ts` says why), so a processor gaining an
 * entity never needs an upgrade transaction that an open tab could block. It
 * moved to 2 once, when the cursor came behind the seam, and every step is
 * `contains`-guarded so an existing database gains the missing store and keeps
 * every row it had.
 */
function upgrade(db: IDBDatabase): void {
	if (!db.objectStoreNames.contains(CURSORS)) db.createObjectStore(CURSORS);
	if (!db.objectStoreNames.contains(CURRENT)) db.createObjectStore(CURRENT);
	if (!db.objectStoreNames.contains(VERSIONS)) {
		const versions = db.createObjectStore(VERSIONS);
		versions.createIndex(LOWER_INDEX, 'lower');
		versions.createIndex(UPPER_INDEX, 'upper');
	}
	if (!db.objectStoreNames.contains(BLOCKS)) {
		const blocks = db.createObjectStore(BLOCKS, {keyPath: 'number'});
		blocks.createIndex(HASH_INDEX, 'hash', {unique: true});
	}
}

/**
 * A version is a COMPLETE row: the id columns, plus every declared field, with
 * the ones the mutation did not list written as NULL rather than carried
 * forward. A store that carried them forward would be keeping deltas while
 * claiming to keep versions.
 */
function completeRow(
	entity: NormalizedEntity,
	id: readonly string[],
	values: Record<string, unknown> | undefined,
): Record<string, unknown> {
	const row: Record<string, unknown> = {};
	entity.id.forEach((column, index) => (row[column] = id[index]));
	for (const field of Object.keys(entity.fields)) {
		row[field] = values?.[field] ?? null;
	}
	return row;
}

/**
 * Abort the transaction and return the error to throw.
 *
 * The rejection of the transaction promise is swallowed deliberately: the caller
 * is about to be told what happened in better words than `AbortError`, and an
 * unobserved rejection would surface as an unhandled one.
 */
function abort(tx: IDBTransaction, settled: Promise<void>, message: string): Error {
	settled.catch(() => undefined);
	tx.abort();
	return new Error(message);
}
