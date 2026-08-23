import type {EntityDeclaration, RetentionSetting, StateStore} from '@etherfold/state-store';
import {IndexedDBStateStore} from '@etherfold/state-store-indexeddb';

/**
 * Build the `StateStore` a browser deployment keeps its entity state in.
 *
 * This is where an application developer CHOOSES a storage backend for the
 * browser, and the choice is a line of configuration rather than a change to any
 * processor: the processor is entity declarations plus `on<EventName>` handlers
 * over a `MutationContext`, and it names no backend at all.
 *
 * ```ts
 * // the default: versioned rows in IndexedDB (ADR-0024)
 * const store = await createBrowserStateStore(processor.entities);
 *
 * // the same app on the light store instead: nothing else changes
 * const store = await createBrowserStateStore(processor.entities, {
 *   backend: (entities) => new PatchStateStore(entities, {retention: 'revert-only', finalityDepth: 64}),
 * });
 * ```
 *
 * ## Why IndexedDB is the default
 *
 * Measured rather than preferred, on the real workload, and recorded as a
 * CONDITION in **ADR-0024**: what would have to be true for wasm SQLite to win,
 * and what would overturn the answer. The short of it is that IndexedDB beat
 * wasm SQLite on writes by 1.6x to 6.9x and on reads by 4x to 14x on every
 * engine that can run both, that WebKit cannot run the SQLite route at all, and
 * that three of four tabs fail AT OPEN on both SQLite VFSs.
 *
 * ## It is NOT the same thing as `keepStateOnIndexedDB`
 *
 * They both write to IndexedDB and they are different seams, so the two names
 * sitting near each other is worth one sentence. `keepStateOnIndexedDB` is a
 * `KeepState` keeper: it serialises the WHOLE state object of a
 * `JSObjectEventProcessor` on every save, which is the fastest writer at today's
 * sizes (2.0 ms/block on Chromium) precisely because it keeps no history, cannot
 * answer an as-of read and cannot revert. This builds a `StateStore`: the state
 * IS versioned rows, so a write costs what CHANGED, a reload reads only what it
 * asks for, a reorg is a revert, and history is readable to the declared
 * retention. A deployment uses one or the other, according to which processor it
 * runs.
 */
export type BrowserStateStoreFactory = (declarations: readonly EntityDeclaration[]) => StateStore | Promise<StateStore>;

/**
 * What a browser deployment says about where its state lives.
 *
 * The two arms are deliberately exclusive: the options below configure the
 * DEFAULT backend, and a store a host builds itself has already been configured
 * by the host. An option that silently did nothing would be worse than a type
 * error.
 */
export type BrowserStateStoreConfig =
	| {
			/** Versioned rows in IndexedDB. The default, and what ADR-0024 decided. */
			backend?: 'indexeddb';
			/**
			 * The IndexedDB database to keep this state in. Defaults to
			 * `etherfold-state`.
			 *
			 * It is the IDENTITY of the state: several tabs of one app share it (which
			 * is the point), and two unrelated indexers in one origin must not.
			 */
			databaseName?: string;
			/**
			 * How far back superseded versions are kept, in BLOCK NUMBERS. Defaults to
			 * `unbounded`.
			 *
			 * A window is `{blocks: N}` and needs `finalityDepth` beside it, since a
			 * window below the depth a reorg can reach would prune the versions the
			 * revert itself needs. Note the trap recorded in ADR-0019: N BLOCKS is not
			 * N updates of history -- on the real measured stream, event-bearing blocks
			 * are median 429 blocks apart.
			 */
			retention?: RetentionSetting;
			/** The reorg depth this deployment protects against, in block numbers. */
			finalityDepth?: number;
	  }
	| {
			/**
			 * Any other backend: a function from the processor's declarations to a
			 * store.
			 *
			 * This is the whole of "choosing another backend is a configuration
			 * change": `@etherfold/state-store-patch` for a tab that only needs current
			 * state and reorg safety, `MemoryStateStore` in a test, or something a host
			 * wrote itself. What it may not be is a backend this package has to know
			 * about, which is what keeps the browser package from importing every store
			 * that exists.
			 */
			backend: BrowserStateStoreFactory;
	  };

/**
 * The store, migrated and ready.
 *
 * `migrate` is called here (it is idempotent everywhere) so that a host gets
 * something it can read from, rather than a store that throws on first use for a
 * reason it has to learn.
 */
export async function createBrowserStateStore(
	declarations: readonly EntityDeclaration[],
	config: BrowserStateStoreConfig = {},
): Promise<StateStore> {
	const store =
		typeof config.backend === 'function'
			? await config.backend(declarations)
			: new IndexedDBStateStore(declarations, {
					databaseName: config.databaseName,
					retention: config.retention,
					finalityDepth: config.finalityDepth,
				});
	await store.migrate();
	return store;
}
