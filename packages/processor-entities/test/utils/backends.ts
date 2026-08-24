import 'fake-indexeddb/auto';
import {createClient} from '@libsql/client';
import {MemoryStateStore, type EntityDeclaration, type StateStore} from '@etherfold/state-store';
import {IndexedDBStateStore} from '@etherfold/state-store-indexeddb';
import {PatchStateStore} from '@etherfold/state-store-patch';
import {VersionedStateStore} from '@etherfold/state-store-sqlite';
import {RemoteLibSQL} from 'remote-sql-libsql';

/**
 * The four shipped backends, each with a way to REOPEN the same state.
 *
 * `reopen` is what makes "the cursor survives a reload" assertable rather than
 * asserted-to. It has to mean, per backend, whatever a restart actually is:
 *
 * - **sqlite**: a NEW `VersionedStateStore` over the same `RemoteSQL` handle, which
 *   is what a server process does when it comes back up against its database.
 * - **indexeddb**: a new store over the same DATABASE NAME, which is what a tab
 *   does on reload (the name is the identity of the state; see
 *   `IndexedDBStateStoreOptions.databaseName`).
 * - **memory** and **patch**: the SAME instance, because neither of them survives
 *   the process and both say so -- the patch store reports
 *   `durability: 'memory-only'` for exactly this reason (ADR-0023). What a
 *   restart means for them is a fresh processor over state that is still there,
 *   which is the half of the round trip they CAN honour, and pretending
 *   otherwise would be testing a claim they do not make.
 *
 * `fake-indexeddb/auto` is imported here rather than in each test, at the top,
 * because it installs the global factory and must be in place before a store
 * opens anything.
 */
export type Backend = {
	readonly name: string;
	/** A store over storage nothing else is using. */
	open(declarations: readonly EntityDeclaration[]): Promise<StateStore>;
	/** Another store over the SAME storage: what a restart sees. */
	reopen(previous: StateStore, declarations: readonly EntityDeclaration[]): Promise<StateStore>;
	/** Whether this backend's storage outlives the store object that wrote it. */
	readonly durable: boolean;
};

let databaseCounter = 0;

/** The libSQL handle each sqlite store was opened over, so `reopen` finds it again. */
const handles = new WeakMap<StateStore, RemoteLibSQL>();
/** The IndexedDB database name each store was opened on, for the same reason. */
const databases = new WeakMap<StateStore, string>();

export const BACKENDS: readonly Backend[] = [
	{
		name: 'memory',
		durable: false,
		open: async (declarations) => new MemoryStateStore(declarations),
		reopen: async (previous) => previous,
	},
	{
		name: 'sqlite',
		durable: true,
		open: async (declarations) => {
			const db = new RemoteLibSQL(createClient({url: ':memory:'}));
			const store = new VersionedStateStore(db, declarations);
			handles.set(store, db);
			return store;
		},
		reopen: async (previous, declarations) => {
			const db = handles.get(previous) as RemoteLibSQL;
			const store = new VersionedStateStore(db, declarations);
			handles.set(store, db);
			return store;
		},
	},
	{
		name: 'indexeddb',
		durable: true,
		open: async (declarations) => {
			const databaseName = `entity-event-processor-${++databaseCounter}`;
			const store = new IndexedDBStateStore(declarations, {databaseName});
			databases.set(store, databaseName);
			return store;
		},
		reopen: async (previous, declarations) => {
			const databaseName = databases.get(previous) as string;
			// the tab closes before it reopens: a browser cannot hold two connections
			// through a version change, and a test that leaves one open blocks the next.
			await (previous as IndexedDBStateStore).close();
			const store = new IndexedDBStateStore(declarations, {databaseName});
			databases.set(store, databaseName);
			return store;
		},
	},
	{
		name: 'patch',
		durable: false,
		open: async (declarations) => new PatchStateStore(declarations, {retention: 'revert-only'}),
		reopen: async (previous) => previous,
	},
];
