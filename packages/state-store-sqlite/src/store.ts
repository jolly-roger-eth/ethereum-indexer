import {logs} from 'named-logs';
import type {RemoteSQL, SQLPreparedStatement} from 'remote-sql';
import {DEFAULT_BATCH_BOUNDS, planBatches, type BatchBounds} from './batching.js';
import {
	NoSuchBlockError,
	parseBlockAddress,
	type BlockAddress,
	type ParsedBlockAddress,
	type RecordedBlock,
} from './blocks.js';
import {
	assertRetained,
	boundedListing,
	mustGet,
	normalizeEntities,
	resolveRetention,
	retentionWithoutPruning,
	type EntityIdPrefix,
	type Listing,
	type Retention,
	type RetentionOptions,
	type RetentionSetting,
	type StateStore,
	type StateStoreCapabilities,
} from '@etherfold/state-store';
import {migrationStatements} from './ddl.js';
import {
	AS_OF_PREDICATE,
	CURRENT_PREDICATE,
	applyBlockStatements,
	blockAtOrBeforeStatement,
	blockByHashStatement,
	blockByNumberStatement,
	idPredicate,
	idValues,
	latestBlockStatement,
	listAsOfStatement,
	listCurrentStatement,
	revertToStatements,
} from './statements.js';
import type {
	BlockPointer,
	BlockUpdate,
	EntityDeclaration,
	EntityId,
	Mutation,
	NormalizedEntity,
	Statement,
} from './types.js';

const logger = logs('@etherfold/state-store-sqlite');

export type VersionedStateStoreOptions = RetentionOptions & {
	/** Per-request limits of the backend. See `DEFAULT_BATCH_BOUNDS`. */
	bounds?: Partial<BatchBounds>;
	/**
	 * How far back this deployment wants superseded versions kept, in BLOCK
	 * NUMBERS. Defaults to `unbounded`, which is what this store does today.
	 *
	 * A window is validated here (below the finality depth it is refused, naming
	 * both numbers) and then NOT claimed, because this package has no pruning:
	 * see `capabilities`. `revert-only` is honoured in full, since refusing every
	 * historical read needs no pruning at all.
	 */
	retention?: RetentionSetting;
};

/** Options for a query over a whole entity table. */
export type QueryOptions = {
	/**
	 * An additional SQL predicate, ANDed with the validity predicate. It is
	 * caller-supplied SQL: pass values through `args`, never by interpolation.
	 */
	where?: string;
	args?: unknown[];
	/** Caller-supplied SQL, same warning as `where`. */
	orderBy?: string;
	limit?: number;
	offset?: number;
};

/**
 * Entity state as versioned rows with a half-open block-validity range.
 *
 * Every version of every entity is a row carrying `_lower` (valid from,
 * inclusive) and `_upper` (valid until, exclusive; NULL means live). The current
 * value is never stored alone, so "the state at block N" is one indexed range
 * predicate rather than a replay, and a reorg is two SQL moves rather than an
 * undo log.
 *
 * The declaration is `{name, id, fields}` and the store owns everything else:
 * the DDL, the writes, the as-of reads, and `revertTo`.
 *
 * It speaks only the `remote-sql` interface, so the same code runs on a local
 * SQLite file, on libSQL/Turso, and on hosted SQLite reached over HTTP.
 *
 * It is one implementation of `StateStore` (`@etherfold/state-store`), which is
 * the seam a processor is written against. Everything below the `StateStore`
 * methods -- block addressing by hash and by time, and the `queryCurrent` /
 * `queryAsOf` surface that takes caller-supplied SQL -- is this backend's own
 * and deliberately NOT at the seam: a server has a query planner and a handler,
 * running once per event on every backend, does not.
 */
export class VersionedStateStore implements StateStore {
	private readonly entities: ReadonlyMap<string, NormalizedEntity>;
	private readonly bounds: BatchBounds;
	private readonly provided: Retention;

	constructor(
		private readonly db: RemoteSQL,
		declarations: Iterable<EntityDeclaration>,
		options: VersionedStateStoreOptions = {},
	) {
		this.entities = normalizeEntities(declarations);
		this.bounds = {...DEFAULT_BATCH_BOUNDS, ...options.bounds};
		// Resolved at CONSTRUCTION, before `migrate` and before any read: a window
		// below the finality depth is a configuration error, and it belongs where it
		// was configured rather than on the first read it would have answered wrongly.
		const requested = resolveRetention(options.retention, options);
		this.provided = retentionWithoutPruning(requested);
		if (requested.kind === 'window') {
			logger.warn(
				`retention was set to a window of ${requested.blocks} blocks, and this store has no pruning: it keeps every ` +
					`version and reports \`unbounded\`. Reads are unaffected (nothing is missing); storage is NOT bounded by ` +
					`that window.`,
			);
		}
	}

	/** The declared entities, after validation. */
	get declarations(): ReadonlyMap<string, NormalizedEntity> {
		return this.entities;
	}

	/**
	 * What this store keeps, and what it can answer, as data a caller reads at
	 * startup rather than inferring from a wrong answer later.
	 *
	 * `unbounded` is the HONEST report, not an aspiration: this package has no
	 * pruning at all, so every version ever written is still here whatever a
	 * deployment set. A window is therefore accepted, validated, and then NOT
	 * claimed (it is reported as `unbounded`, with a warning), because a store
	 * that claimed a window it cannot enforce would be making exactly the claim
	 * this report exists to prevent. `prune-versions-outside-retention-window` is
	 * what earns the right to report a window.
	 *
	 * `revert-only` IS reported when it is set, because it is enforceable with no
	 * pruning: every as-of read is refused (`getAsOf`, `queryAsOf`) while
	 * `revertTo` keeps working.
	 */
	get capabilities(): StateStoreCapabilities {
		return {retention: this.provided, asOf: this.provided.kind !== 'revert-only'};
	}

	/**
	 * Create the fixed tables and the declared entity tables with their indexes.
	 * Idempotent, so it is safe on every boot, and chunked rather than atomic
	 * because re-running it converges (see `migrationStatements`).
	 */
	async migrate(): Promise<void> {
		const statements = migrationStatements(this.entities.values());
		logger.debug(`migrating ${this.entities.size} entities (${statements.length} DDL statements)`);
		// each DDL statement is its own group: none of them depend on the others
		for (const batch of planBatches(
			statements.map((statement) => [statement]),
			this.bounds,
		)) {
			await this.db.batch(this.prepare(batch));
		}
	}

	// -- write side ----------------------------------------------------------

	/**
	 * Apply one block: the block row plus every entity mutation, as EXACTLY one
	 * `batch([...])`.
	 *
	 * That single call is both boundaries at once. It is the atomicity boundary,
	 * since `remote-sql` exposes a transaction only as a batch, so a failure
	 * anywhere in it leaves no part of the block applied. And it is the
	 * round-trip boundary, which is what actually costs on a remote backend.
	 *
	 * **Which blocks get a row is the CALLER's judgement, not the store's.** Every
	 * block handed to this method is recorded, including one with no mutations,
	 * and nothing else is. The contract is therefore that the caller hands over
	 * exactly the blocks that carried our logs, because "carries our logs" is not
	 * "produces a state mutation": a block can carry a log of ours that changes
	 * nothing, and a consumer can legitimately pin that block's hash. The store
	 * cannot make that call, since it sees mutations and not logs, and inferring
	 * it from a non-empty mutation list would make exactly those pinnable hashes
	 * unresolvable. Pinned by `test/batch.test.ts` and `test/block-addressing.test.ts`.
	 */
	async applyBlock(block: BlockPointer, mutations: readonly Mutation[] = []): Promise<void> {
		const statements = applyBlockStatements(this.entities, block, mutations);
		if (statements.length > this.bounds.maxStatementsPerBatch) {
			logger.warn(
				`block ${block.number} needs ${statements.length} statements, above the configured bound of ` +
					`${this.bounds.maxStatementsPerBatch}. Sent as one batch regardless: a block is one atomic unit.`,
			);
		}
		await this.db.batch(this.prepare(statements));
	}

	/**
	 * Apply several blocks, packing as many as fit into each batch.
	 *
	 * Backfill is bound by round-trips, not by SQLite work, so packing blocks is
	 * the difference that matters there. A batch remains one transaction however
	 * many blocks it carries, and a block is never split across two batches.
	 */
	async applyBlocks(updates: readonly BlockUpdate[]): Promise<void> {
		const groups = updates.map((update) => applyBlockStatements(this.entities, update.block, update.mutations));
		const batches = planBatches(groups, this.bounds);
		logger.debug(`applying ${updates.length} blocks in ${batches.length} batches`);
		for (const batch of batches) {
			await this.db.batch(this.prepare(batch));
		}
	}

	/**
	 * Roll the state back to `keepUpTo`, dropping everything above it.
	 *
	 * Afterwards the store IS the state as of `keepUpTo`: history below the fork
	 * is untouched and still time-travellable, and the canonical branch replays
	 * normally. The order of the statements is load-bearing; the reason lives on
	 * `revertToStatements`.
	 */
	async revertTo(keepUpTo: number): Promise<void> {
		logger.info(`reverting state above block ${keepUpTo}`);
		const statements = revertToStatements(this.entities, keepUpTo);
		// one batch: a partially reverted store would violate the one-live-version
		// invariant while it lasted.
		await this.db.batch(this.prepare(statements));
	}

	// -- block addressing ----------------------------------------------------

	/**
	 * Resolve any of the three axes to the block number the reads are keyed on,
	 * or `undefined` if it identifies no block this store can answer about.
	 *
	 * This is the soft form of the resolution the reads do: it branches instead of
	 * throwing (`NoSuchBlockError`), which is what a caller wants when an unknown
	 * hash is an expected outcome rather than an alarm.
	 *
	 * - **hash** probes the unique index. Unknown means never indexed or reorged
	 *   out, and those are the same answer: not a block we can speak for.
	 * - **height** resolves to itself, with NO lookup. Only blocks carrying our
	 *   logs have rows, while every height is a valid point on the version ranges.
	 * - **timestamp** is the latest recorded block at or before T; before the first
	 *   recorded block it is `undefined`, never the first block.
	 */
	async resolveBlockNumber(address: BlockAddress): Promise<number | undefined> {
		const parsed = parseBlockAddress(address);
		if (parsed.axis === 'height') return parsed.number;
		return (await this.lookupBlock(parsed))?.number;
	}

	/**
	 * The recorded block an address identifies, with its hash, or `undefined` if
	 * no row matches.
	 *
	 * The intended use is turning a soft address into the hard one: a consumer
	 * asks by time or by height, and stores the `hash` it gets back, so that a
	 * later reorg answers "no such block" instead of silently answering about a
	 * different chain. Note that a height with no row is `undefined` here while
	 * being perfectly readable through `getAsOf`, which is the asymmetry documented
	 * in `blocks.ts`: we record blocks that carry our logs, not chain headers.
	 */
	async getBlock(address: BlockAddress): Promise<RecordedBlock | undefined> {
		return this.lookupBlock(parseBlockAddress(address));
	}

	/**
	 * The highest recorded block, or `undefined` before the first one is applied.
	 *
	 * This is the TIP a retention window is measured back from, and it is read
	 * ONLY when a window is claimed: `assertRetained` takes it as a thunk, so an
	 * `unbounded` store (which refuses nothing) and a `revert-only` store (which
	 * refuses everything) never pay the round-trip.
	 */
	private async tipBlockNumber(): Promise<number | undefined> {
		const statement = latestBlockStatement();
		const result = await this.db
			.prepare(statement.sql)
			.bind(...statement.args)
			.all<RecordedBlock>();
		return result.results[0]?.number;
	}

	private async lookupBlock(parsed: ParsedBlockAddress): Promise<RecordedBlock | undefined> {
		const statement =
			parsed.axis === 'hash'
				? blockByHashStatement(parsed.hash)
				: parsed.axis === 'timestamp'
					? blockAtOrBeforeStatement(parsed.timestamp)
					: blockByNumberStatement(parsed.number);
		const result = await this.db
			.prepare(statement.sql)
			.bind(...statement.args)
			.all<RecordedBlock>();
		return result.results[0];
	}

	/**
	 * The resolution the reads use: a block number, or a thrown `NoSuchBlockError`.
	 *
	 * Costs one extra round-trip on the hash and timestamp axes, and none on the
	 * height axis. Folding the resolution into the read as a sub-select would save
	 * that trip, but a sub-select that matched nothing would make the as-of
	 * predicate false and return an empty result, which is the one confusion this
	 * whole seam exists to prevent: "no such block" would become "entity absent".
	 */
	private async resolveForRead(address: BlockAddress): Promise<number> {
		const parsed = parseBlockAddress(address);
		if (parsed.axis === 'height') return parsed.number;
		const found = await this.lookupBlock(parsed);
		if (found) return found.number;
		throw new NoSuchBlockError(address, parsed.axis === 'hash' ? 'unknown-hash' : 'no-recorded-block-at-or-before');
	}

	// -- read side (time travel) ---------------------------------------------

	/**
	 * One entity as of a block hash, a height, or a timestamp.
	 *
	 * All three resolve to a block number (`resolveBlockNumber`) and then run the
	 * one as-of predicate, so they answer identically when they identify the same
	 * block.
	 *
	 * `undefined` means the block is known and the entity was absent from it. An
	 * address that identifies no block THROWS `NoSuchBlockError` instead, because
	 * those two are not the same news: see `blocks.ts`. A block this store does
	 * not RETAIN throws `BlockNotRetainedError`, the other member of that family:
	 * the address was fine, the history is gone, and answering from the tip would
	 * be a plausible wrong number.
	 */
	async getAsOf<T = Record<string, unknown>>(entity: string, id: EntityId, at: BlockAddress): Promise<T | undefined> {
		const declaration = mustGet(this.entities, entity);
		const blockNumber = await this.resolveForRead(at);
		await assertRetained(this.capabilities, blockNumber, () => this.tipBlockNumber());
		const result = await this.db
			.prepare(`SELECT * FROM ${declaration.name} WHERE ${idPredicate(declaration)} AND ${AS_OF_PREDICATE} LIMIT 1`)
			.bind(...idValues(declaration, id), blockNumber, blockNumber)
			.all<T>();
		return result.results[0];
	}

	/** One entity as it is at the tip: the open-row special case. */
	async getCurrent<T = Record<string, unknown>>(entity: string, id: EntityId): Promise<T | undefined> {
		const declaration = mustGet(this.entities, entity);
		const result = await this.db
			.prepare(`SELECT * FROM ${declaration.name} WHERE ${idPredicate(declaration)} AND ${CURRENT_PREDICATE} LIMIT 1`)
			.bind(...idValues(declaration, id))
			.all<T>();
		return result.results[0];
	}

	/**
	 * The children of an id PREFIX at the tip: one indexed range scan, bounded.
	 *
	 * This is the seam's only set read, and it is deliberately the poor relation of
	 * `queryCurrent` below: no predicate, no caller-supplied ordering, no offset.
	 * The reason is not taste but WHERE IT RUNS. A handler runs once per event on
	 * every backend, including the ones with no query planner, so the seam gets the
	 * one shape that is an indexed range scan everywhere; a server-side caller with
	 * a planner underneath it uses `queryCurrent`. See `listStatement` for the
	 * access path, which `test/listing.test.ts` pins with `EXPLAIN QUERY PLAN`.
	 */
	async listCurrent<T = Record<string, unknown>>(
		entity: string,
		prefix: EntityIdPrefix,
		limit: number,
	): Promise<Listing<T>> {
		const statement = listCurrentStatement(mustGet(this.entities, entity), prefix, limit);
		return boundedListing(await this.select<T>(statement), limit);
	}

	/**
	 * The same range as of a block hash, a height or a timestamp.
	 *
	 * Same resolution and the same two refusals as `getAsOf`: an address that
	 * identifies no block throws `NoSuchBlockError`, and a block outside what this
	 * store retains throws `BlockNotRetainedError`. An EMPTY listing means the
	 * block is known and the prefix had no children then.
	 */
	async listAsOf<T = Record<string, unknown>>(
		entity: string,
		prefix: EntityIdPrefix,
		at: BlockAddress,
		limit: number,
	): Promise<Listing<T>> {
		const declaration = mustGet(this.entities, entity);
		const blockNumber = await this.resolveForRead(at);
		await assertRetained(this.capabilities, blockNumber, () => this.tipBlockNumber());
		return boundedListing(await this.select<T>(listAsOfStatement(declaration, prefix, blockNumber, limit)), limit);
	}

	/**
	 * A whole entity table as of a block hash, a height, or a timestamp.
	 *
	 * Same resolution, the same "no such block" contract and the same retention
	 * refusal as `getAsOf`: an empty array means the block is known and nothing
	 * matched, while an address that identifies no block, or a block outside what
	 * this store retains, throws.
	 */
	async queryAsOf<T = Record<string, unknown>>(
		entity: string,
		at: BlockAddress,
		options: QueryOptions = {},
	): Promise<T[]> {
		const declaration = mustGet(this.entities, entity);
		const blockNumber = await this.resolveForRead(at);
		await assertRetained(this.capabilities, blockNumber, () => this.tipBlockNumber());
		const {tail, tailArgs} = paginate(options);
		const result = await this.db
			.prepare(`SELECT * FROM ${declaration.name} WHERE ${AS_OF_PREDICATE}${filter(options)}${order(options)}${tail}`)
			.bind(blockNumber, blockNumber, ...(options.args ?? []), ...tailArgs)
			.all<T>();
		return result.results;
	}

	/** A whole entity table as it is at the tip. */
	async queryCurrent<T = Record<string, unknown>>(entity: string, options: QueryOptions = {}): Promise<T[]> {
		const declaration = mustGet(this.entities, entity);
		const {tail, tailArgs} = paginate(options);
		const result = await this.db
			.prepare(`SELECT * FROM ${declaration.name} WHERE ${CURRENT_PREDICATE}${filter(options)}${order(options)}${tail}`)
			.bind(...(options.args ?? []), ...tailArgs)
			.all<T>();
		return result.results;
	}

	private async select<T>(statement: Statement): Promise<T[]> {
		const result = await this.db
			.prepare(statement.sql)
			.bind(...statement.args)
			.all<T>();
		return result.results;
	}

	private prepare(statements: readonly Statement[]): SQLPreparedStatement[] {
		return statements.map((statement) => this.db.prepare(statement.sql).bind(...statement.args));
	}
}

function filter(options: QueryOptions): string {
	return options.where ? ` AND (${options.where})` : '';
}

function order(options: QueryOptions): string {
	return options.orderBy ? ` ORDER BY ${options.orderBy}` : '';
}

function paginate(options: QueryOptions): {tail: string; tailArgs: unknown[]} {
	if (options.limit === undefined) return {tail: '', tailArgs: []};
	if (options.offset === undefined) return {tail: ' LIMIT ?', tailArgs: [options.limit]};
	return {tail: ' LIMIT ? OFFSET ?', tailArgs: [options.limit, options.offset]};
}
