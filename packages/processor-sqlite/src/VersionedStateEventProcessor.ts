import {
	VersionedStateStore,
	normalizeBlockTimestamp,
	type BlockPointer,
	type EntityId,
	type Mutation,
} from '@ethereum-indexer/state-store-sqlite';
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
} from 'ethereum-indexer';
import {logs} from 'named-logs';
import type {RemoteSQL} from 'remote-sql';
import {deleteLastSyncStatement, readLastSync, SYNC_SCHEMA_DDL, writeLastSyncStatement} from './sync.js';
import type {MutationContext, SQLProcessor} from './types.js';
import {VersionedStateView} from './view.js';

const logger = logs('@ethereum-indexer/processor-sqlite');

export type VersionedStateProcessorOptions = Record<string, never>;

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
 * `ethereum-indexer-js-processor/test/reorg.test.ts` and expects the same states.
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
		private readonly processor: SQLProcessor<ABI, ProcessorConfig>,
	) {
		// Refused at construction, not at load: a version-less processor's hash is a
		// constant, and a constant invalidates nothing, ever.
		assertProcessorVersion(processor, 'VersionedStateEventProcessor');
		this.version = processor.version;
		this.store = new VersionedStateStore(db, processor.entities);
		this.view = new VersionedStateView(this.store);
	}

	/** The read handle, also what `load` and `process` hand back. */
	get state(): VersionedStateView {
		return this.view;
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

		// No gate here on purpose. Every node implementing execution-apis#639 puts
		// `blockTimestamp` on the log itself, so requiring `alwaysFetchTimestamps`
		// would force a pointless second round-trip per block on geth, reth, besu,
		// erigon and anvil, which is precisely what this package wants to avoid in a
		// browser (ADR-0002). The check that matters is per-block, in `blockPointer`:
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
	 * Apply a stream, reverting first if any of it is a retraction.
	 *
	 * The stream is a flat list in which reorged-out events carry `removed: true`
	 * and are followed by the canonical replacements, if there are any. Three
	 * things about how that becomes SQL are load-bearing:
	 *
	 * 1. **Revert ONCE, at the fork point**, not per removed event. The fork point
	 *    is one below the LOWEST removed block in the stream, and it has to be
	 *    computed over the whole stream before anything is applied. Reverting per
	 *    event would issue N reverts where the second is a no-op at best and, if
	 *    the events were ordered high-to-low, would revert to the wrong height.
	 *
	 * 2. **A removed event is a removed event, whatever caused it.** The engine
	 *    emits retractions both when a height is replaced by a different hash
	 *    (a contradiction) and when a block's logs simply vanish with no
	 *    replacement (an absence: the transaction went back to the mempool). This
	 *    reads `removed` and never looks at what replaced anything, so the second
	 *    case cannot be missed. Wiring the revert to "a new hash appeared at this
	 *    height" would reproduce `d24872f` one layer down, where the symptom is a
	 *    row nobody notices instead of a state object somebody prints.
	 *
	 * 3. **Revert precedes apply**, which is also what makes replay safe. The
	 *    store inserts a block row plainly and a re-applied block raises a
	 *    primary-key violation on purpose. `revertTo(fork)` deletes every block
	 *    row above the fork, and the canonical events in the same stream are all
	 *    at or above `fork + 1`, so the replacements cannot collide with the
	 *    branch they replace.
	 */
	async process(eventStream: LogEvent<ABI>[], lastSync: LastSync<ABI>): Promise<VersionedStateView> {
		if (this.finality === undefined) {
			throw new Error(`finality not set: load() must be called before process()`);
		}
		await this.ensureMigrated();

		const fork = forkPoint(eventStream);
		if (fork !== undefined) {
			logger.info(`retraction in stream: reverting state above block ${fork}`);
			await this.store.revertTo(fork);
		}

		for (const block of groupByBlock(eventStream)) {
			const mutations = await this.runHandlers(block.events);
			await this.store.applyBlock(blockPointer(block), mutations);
		}

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

	private async ensureMigrated(): Promise<void> {
		if (this.migrated) return;
		await this.store.migrate();
		await this.db.batch(SYNC_SCHEMA_DDL.map((sql) => this.db.prepare(sql)));
		this.migrated = true;
	}

	/**
	 * Run the author's handlers over one block's events, collecting mutations.
	 *
	 * Mutations are COALESCED per business key, in first-touch order: the last
	 * write for a key in this block is the one applied. Emitting them all would be
	 * correct but would leave zero-width versions (`_lower = _upper = N`) that no
	 * as-of predicate can ever match, so it would grow the table with rows that
	 * are invisible by construction.
	 */
	private async runHandlers(events: LogEvent<ABI>[]): Promise<Mutation[]> {
		const pending = new Map<string, Mutation>();
		const context: MutationContext = {
			get: async <T>(entity: string, id: EntityId): Promise<T | undefined> => {
				const staged = pending.get(mutationKey(entity, id));
				if (staged) {
					return staged.type === 'delete' ? undefined : ({...staged.values} as T);
				}
				return this.store.getCurrent<T>(entity, id);
			},
			set: (entity: string, id: EntityId, values: Record<string, unknown>): void => {
				pending.set(mutationKey(entity, id), {type: 'upsert', entity, id, values});
			},
			delete: (entity: string, id: EntityId): void => {
				pending.set(mutationKey(entity, id), {type: 'delete', entity, id});
			},
		};

		for (const event of events) {
			if ('decodeError' in event) {
				if (this.processor.handleUnparsedEvent) {
					await this.processor.handleUnparsedEvent(context, event);
				}
				continue;
			}
			const handler = (this.processor as Record<string, unknown>)[`on${event.eventName}`];
			if (typeof handler === 'function') {
				await (handler as (...args: unknown[]) => unknown | Promise<unknown>).call(
					this.processor,
					context,
					event,
					this.config,
				);
			}
		}

		return [...pending.values()];
	}
}

type BlockOfEvents<ABI extends Abi> = {number: number; hash: string; events: LogEvent<ABI>[]};

function mutationKey(entity: string, id: EntityId): string {
	return `${entity}\u0000${Object.keys(id)
		.sort()
		.map((column) => `${column}=${String(id[column])}`)
		.join('\u0000')}`;
}

/**
 * One below the lowest retracted block in the stream, or `undefined` if nothing
 * was retracted.
 *
 * `min` over the whole stream rather than "the first removed event" because the
 * ordering of retractions is the engine's business, not this processor's, and a
 * revert to the wrong height is silent in both directions: too high leaves dead
 * rows live, too low drops canonical history that nothing will re-apply.
 */
export function forkPoint<ABI extends Abi>(eventStream: readonly LogEvent<ABI>[]): number | undefined {
	let lowest: number | undefined;
	for (const event of eventStream) {
		if (!event.removed) continue;
		lowest = lowest === undefined ? event.blockNumber : Math.min(lowest, event.blockNumber);
	}
	return lowest === undefined ? undefined : lowest - 1;
}

/**
 * Group the APPLIED events by block, preserving stream order.
 *
 * Keyed by block hash, matching the core's `groupLogsPerBlock`, so that two
 * distinct blocks at the same height (which is exactly what a reorg produces
 * inside one stream) stay two blocks. Removed events are dropped here: they were
 * already answered by the revert, and re-running them as mutations would apply
 * the dead branch a second time.
 */
export function groupByBlock<ABI extends Abi>(eventStream: readonly LogEvent<ABI>[]): BlockOfEvents<ABI>[] {
	const byHash = new Map<string, BlockOfEvents<ABI>>();
	const ordered: BlockOfEvents<ABI>[] = [];
	for (const event of eventStream) {
		if (event.removed) continue;
		let group = byHash.get(event.blockHash);
		if (!group) {
			group = {number: event.blockNumber, hash: event.blockHash, events: []};
			byHash.set(event.blockHash, group);
			ordered.push(group);
		}
		group.events.push(event);
	}
	return ordered;
}

/**
 * The block row to record, built from the events themselves.
 *
 * The timestamp comes off the log, which is the whole point: a node implementing
 * `execution-apis#639` puts it there, so recording the time axis costs no extra
 * request. When it is missing the block is NOT recorded on a guess. A zero or an
 * interpolated value would not fail, it would answer confidently about the wrong
 * block for as long as the database lives, and `getAsOf({timestamp})` has no way
 * to tell a caller it was lied to.
 */
function blockPointer<ABI extends Abi>(block: BlockOfEvents<ABI>): BlockPointer {
	const withTimestamp = block.events.find((event) => event.blockTimestamp !== undefined);
	if (!withTimestamp || withTimestamp.blockTimestamp === undefined) {
		throw new Error(
			`no blockTimestamp on any event of block ${block.number} (${block.hash}). Nodes implementing ` +
				`execution-apis#639 (geth >= 1.16.0, reth, besu, erigon, anvil) put it on the log itself, but some do ` +
				`not: Hardhat's EDR does not as of hardhat 3.14.0. Set \`stream: {alwaysFetchTimestamps: true}\` on the ` +
				`indexer to fall back to fetching the block, or populate blockTimestamp before feeding. This refuses to ` +
				`guess, because a wrong timestamp breaks the time axis silently.`,
		);
	}
	return {
		number: block.number,
		hash: block.hash,
		timestamp: normalizeBlockTimestamp(withTimestamp.blockTimestamp),
	};
}

/** Mirrors `fromJSProcessor`: a factory, so each indexer gets its own instance. */
export function fromSQLProcessor<ABI extends Abi, ProcessorConfig = undefined>(
	processor: SQLProcessor<ABI, ProcessorConfig> | (() => SQLProcessor<ABI, ProcessorConfig>),
): (db: RemoteSQL) => VersionedStateEventProcessor<ABI, ProcessorConfig> {
	return (db) =>
		new VersionedStateEventProcessor<ABI, ProcessorConfig>(
			db,
			typeof processor === 'function' ? processor() : processor,
		);
}
