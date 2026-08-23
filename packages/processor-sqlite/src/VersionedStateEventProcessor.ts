import {
	VersionedStateStore,
	type PruneOptions,
	type PruneReport,
	type VersionedStateStoreOptions,
} from '@etherfold/state-store-sqlite';
import {applyEventStream, type EntityProcessor} from '@etherfold/processor-entities';
import {
	assertProcessorVersion,
	processorCodeFingerprint,
	simple_hash,
	type Abi,
	type EventProcessor,
	type IndexingSource,
	type LastSync,
	type LogEvent,
	type UsedStreamConfig,
} from '@etherfold/core';
import {logs} from 'named-logs';
import type {RemoteSQL} from 'remote-sql';
import {deleteLastSyncStatement, readLastSync, SYNC_SCHEMA_DDL, writeLastSyncStatement} from './sync.js';
import {VersionedStateView} from './view.js';

/**
 * Re-exported: the stream shaping is backend-agnostic and now lives at the seam,
 * but this package's public surface has always carried these two.
 */
export {forkPoint, groupByBlock} from '@etherfold/processor-entities';

const logger = logs('@etherfold/processor-sqlite');

/**
 * What a deployment chooses about WHERE the state is kept, as opposed to what
 * the processor computes.
 *
 * Retention is the whole of it today, and it is passed straight through to the
 * store, which validates it at construction (a window below the finality depth
 * is refused there, naming both numbers). `finalityDepth` is checked a second
 * time at `load`, against the finality the stream actually runs with; see the
 * note there for why one number configured in two places has to be reconciled
 * rather than trusted.
 *
 * Setting a window bounds what this state ANSWERS immediately; bounding what it
 * HOLDS is `prune`, which the deployment schedules.
 */
export type VersionedStateProcessorOptions = Pick<VersionedStateStoreOptions, 'retention' | 'finalityDepth'>;

/**
 * An `EventProcessor` whose derived state is versioned rows in a SQL store
 * rather than an object in memory, so indexing produces time-travellable state
 * as a side effect of ordinary processing.
 *
 * ## Revert is replay-free, and that is ADR-0001's revisit condition arriving
 *
 * The in-memory path (`JSObjectEventProcessor` + `History`) undoes a reorg with
 * immer reverse-patches, because reverting by replay needs the state as of the
 * fork block and the in-browser path has no way to get it. ADR-0001 records that
 * choice and names the condition that would justify revisiting it: a store that
 * can answer "state as of block N". This is that store, and it revisits the
 * choice in the direction the ADR left open. Reverting here is neither replay
 * nor an undo log: it is `revertTo(keepUpTo)`, two SQL moves per table over the
 * validity ranges, because the history IS the storage model.
 *
 * The observable contract is unchanged, and that is asserted rather than
 * asserted-to: `test/reorg.test.ts` here runs the same scenarios as
 * `@etherfold/js-processor/test/reorg.test.ts` and expects the same states.
 */
export class VersionedStateEventProcessor<ABI extends Abi, ProcessorConfig = undefined> implements EventProcessor<
	ABI,
	VersionedStateView
> {
	private readonly store: VersionedStateStore;
	private readonly view: VersionedStateView;
	private readonly version: string;
	private config: ProcessorConfig | undefined;
	/** Kept for the context a future rebuild/upgrade path will need; not read on the hot path. */
	protected source: IndexingSource<ABI> | undefined;
	private finality: number | undefined;
	private migrated = false;

	constructor(
		private readonly db: RemoteSQL,
		private readonly processor: EntityProcessor<ABI, ProcessorConfig>,
		private readonly options: VersionedStateProcessorOptions = {},
	) {
		// Refused at construction, not at load: a version-less processor's hash is a
		// constant, and a constant invalidates nothing, ever.
		assertProcessorVersion(processor, 'VersionedStateEventProcessor');
		this.version = processor.version;
		// The retention setting is validated here too, by the store, and for the same
		// reason: a floor violation is a configuration error and belongs where it was
		// configured, not on the first read it would have answered wrongly.
		this.store = new VersionedStateStore(db, processor.entities, options);
		this.view = new VersionedStateView(this.store);
	}

	/** The read handle, also what `load` and `process` hand back. */
	get state(): VersionedStateView {
		return this.view;
	}

	/**
	 * Enforce the configured retention against the storage: drop the versions it
	 * no longer covers.
	 *
	 * It lives HERE and not on `state` because it is a WRITE, and the view is
	 * read-only for the reason recorded on it: a UI callback holding a handle that
	 * can delete versions is a corruption waiting to happen. The processor is the
	 * writer, so scheduling a prune is scheduling one more thing the writer does.
	 *
	 * It is a call a deployment makes rather than something `process` does on its
	 * own, and that placement is deliberate: pruning costs time proportional to
	 * what it drops (1.1 s at 62,553 versions, measured in
	 * `work/notes/findings/sqlite-in-the-browser.md`), so a prune inside `process`
	 * would stall whichever block crossed a threshold. See `StateStore.prune` for
	 * the whole reasoning and for `maxVersions`, which is how an amortised policy
	 * is expressed. Call it BETWEEN `process` calls: it is a write, and this
	 * processor has one writer.
	 *
	 * On the default (`unbounded`) retention it is a no-op, so a host may schedule
	 * it unconditionally.
	 */
	async prune(options?: PruneOptions): Promise<PruneReport> {
		await this.ensureMigrated();
		return this.store.prune(options);
	}

	/**
	 * Identity of the processor's LOGIC, which is what invalidates stored state.
	 *
	 * The entity declarations are hashed in alongside the version, unlike the
	 * in-memory path which hashes only `version` and config. Here the schema is
	 * part of the state's meaning: renaming a field or changing its type makes
	 * previously written rows mean something else, and a stale `version` string
	 * would let the core adopt them. The core compares this against the stored
	 * cursor's `context.processor` and clears on a mismatch.
	 *
	 * There is no fallback constant left in it. `version` is validated at
	 * construction, so `${version || 'unknown'}` has nothing to fall back to, and
	 * the config half is hashed the same way whether or not `configure()` was
	 * called rather than substituting a `'not-configured'` literal: an
	 * unconfigured processor and one configured with `undefined` are the same
	 * processor, and the old form discarded state on the difference between them.
	 */
	getVersionHash(): string {
		return `${this.version}-${simple_hash({entities: this.processor.entities, config: this.config})}`;
	}

	/**
	 * Advisory; see `EventProcessor.getCodeFingerprint`.
	 *
	 * The entity declarations are already in the version hash, and this covers
	 * what they cannot: the handlers. A schema change here invalidates state on
	 * its own; a handler change is invisible to every hash the author controls,
	 * which is exactly the gap this fills. Taken from the author's object, whose
	 * `on<Event>` functions and `handleUnparsedEvent` are the logic.
	 */
	getCodeFingerprint(): string | undefined {
		return processorCodeFingerprint(this.processor);
	}

	configure(config: ProcessorConfig): void {
		this.config = config;
	}

	async load(
		source: IndexingSource<ABI>,
		streamConfig: UsedStreamConfig,
	): Promise<{state: VersionedStateView; lastSync: LastSync<ABI>} | undefined> {
		this.source = source;
		this.finality = streamConfig.finality;
		this.assertRetentionCoversReorgs(streamConfig.finality);

		// No gate here on purpose. Every node implementing execution-apis#639 puts
		// `blockTimestamp` on the log itself, so requiring `alwaysFetchTimestamps`
		// would force a pointless second round-trip per block on geth, reth, besu,
		// erigon and anvil, which is precisely what this package wants to avoid in a
		// browser (ADR-0002). The check that matters is per-block, in `blockPointer`
		// (`@etherfold/processor-entities`):
		// it cannot be known in advance whether a node supplies timestamps, but a
		// block still cannot be recorded without one, and the failure lands on the
		// FIRST block, before anything is written.
		await this.ensureMigrated();

		const lastSync = await readLastSync<ABI>(this.db);
		if (!lastSync) return undefined;
		// Returned even when the context does not match: the core's discard path
		// (which is what calls `clear()`) only runs when `load` returns something.
		// See the note in `sync.ts`.
		return {state: this.view, lastSync};
	}

	/**
	 * Apply a stream, reverting first if any of it is a retraction, then move the
	 * cursor.
	 *
	 * The stream handling itself is `applyEventStream`, at the seam: reverting
	 * ONCE at the fork point, grouping by block hash, running the handlers with
	 * read-your-writes and applying each block as one atomic unit. None of that is
	 * SQL, and none of it is duplicated per backend; the reasoning lives on
	 * `applyEventStream`.
	 *
	 * What is left here is the half that IS this package's: the `LastSync` cursor,
	 * which lives in this package's own `_sync` table because where a processor
	 * keeps its cursor is a property of where its state lives (ADR-0016).
	 */
	async process(eventStream: LogEvent<ABI>[], lastSync: LastSync<ABI>): Promise<VersionedStateView> {
		if (this.finality === undefined) {
			throw new Error(`finality not set: load() must be called before process()`);
		}
		await this.ensureMigrated();

		await applyEventStream(this.store, this.processor, eventStream, this.config as ProcessorConfig);

		const cursor = writeLastSyncStatement(lastSync);
		await this.db.batch([this.db.prepare(cursor.sql).bind(...cursor.args)]);

		return this.view;
	}

	/**
	 * Wipe the state back to empty.
	 *
	 * `revertTo(-1)` is the whole of it, through the store's public API: every
	 * version has `_lower >= 0`, so "drop everything opened above -1" is "drop
	 * everything", and the same statement clears the block table. The cursor is
	 * this package's own table and is deleted alongside, because a cursor without
	 * the state it points at would have the core resume into an empty database.
	 */
	async reset(): Promise<void> {
		logger.info(`resetting: wiping versioned state and the sync cursor`);
		await this.ensureMigrated();
		await this.store.revertTo(-1);
		const statement = deleteLastSyncStatement();
		await this.db.batch([this.db.prepare(statement.sql).bind(...statement.args)]);
	}

	/**
	 * Same as `reset`.
	 *
	 * The in-memory path distinguishes the two because it has two places to
	 * forget: `reset` drops the object it holds, `clear` also asks the `KeepState`
	 * keeper to drop the persisted copy. Here there is one place, the database, so
	 * collapsing them is the honest implementation rather than a shortcut. The
	 * core calls `clear` on a context mismatch and `reset` on a rebuild, and both
	 * mean the same thing to a store whose state is never anywhere else.
	 */
	async clear(): Promise<void> {
		return this.reset();
	}

	// -- internals -----------------------------------------------------------

	/**
	 * Reconcile the two places the finality depth is stated.
	 *
	 * A retention window is validated at construction against the depth the
	 * DEPLOYMENT declared, because that is the only number available before a
	 * stream exists. The number that decides how deep a reorg can actually reach
	 * is the stream's, and it arrives here. If the declared floor is shallower
	 * than the stream's finality, the window was validated against the wrong
	 * number: a reorg could reach past the versions retention promised to keep,
	 * and nothing would say so until a deep reorg found out.
	 *
	 * Raised rather than warned, and only ever for a deployment that opted into
	 * retention: the default (`unbounded`) states no floor and cannot disagree
	 * with one.
	 */
	private assertRetentionCoversReorgs(streamFinality: number): void {
		const declared = this.options.finalityDepth;
		if (declared === undefined || declared >= streamFinality) return;
		throw new Error(
			`retention was configured against a finality depth of ${declared}, but this stream runs with a finality of ` +
				`${streamFinality}: a reorg can reach ${streamFinality} blocks back, deeper than the floor the retention ` +
				`window was checked against. Set the processor's finalityDepth to ${streamFinality} or more (and the ` +
				`retention window at or above it).`,
		);
	}

	private async ensureMigrated(): Promise<void> {
		if (this.migrated) return;
		await this.store.migrate();
		await this.db.batch(SYNC_SCHEMA_DDL.map((sql) => this.db.prepare(sql)));
		this.migrated = true;
	}
}

/** Mirrors `fromJSProcessor`: a factory, so each indexer gets its own instance. */
export function fromSQLProcessor<ABI extends Abi, ProcessorConfig = undefined>(
	processor: EntityProcessor<ABI, ProcessorConfig> | (() => EntityProcessor<ABI, ProcessorConfig>),
	options: VersionedStateProcessorOptions = {},
): (db: RemoteSQL) => VersionedStateEventProcessor<ABI, ProcessorConfig> {
	return (db) =>
		new VersionedStateEventProcessor<ABI, ProcessorConfig>(
			db,
			typeof processor === 'function' ? processor() : processor,
			options,
		);
}
