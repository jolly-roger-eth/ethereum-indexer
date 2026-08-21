import {logs} from 'named-logs';
import type {RemoteSQL, SQLPreparedStatement} from 'remote-sql';
import {DEFAULT_BATCH_BOUNDS, planBatches, type BatchBounds} from './batching.js';
import {migrationStatements} from './ddl.js';
import {mustGet, normalizeEntities} from './internal/identifiers.js';
import {
	AS_OF_PREDICATE,
	CURRENT_PREDICATE,
	applyBlockStatements,
	idPredicate,
	idValues,
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

const logger = logs('@ethereum-indexer/state-store-sqlite');

export type VersionedStateStoreOptions = {
	/** Per-request limits of the backend. See `DEFAULT_BATCH_BOUNDS`. */
	bounds?: Partial<BatchBounds>;
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
 */
export class VersionedStateStore {
	private readonly entities: ReadonlyMap<string, NormalizedEntity>;
	private readonly bounds: BatchBounds;

	constructor(
		private readonly db: RemoteSQL,
		declarations: Iterable<EntityDeclaration>,
		options: VersionedStateStoreOptions = {},
	) {
		this.entities = normalizeEntities(declarations);
		this.bounds = {...DEFAULT_BATCH_BOUNDS, ...options.bounds};
	}

	/** The declared entities, after validation. */
	get declarations(): ReadonlyMap<string, NormalizedEntity> {
		return this.entities;
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

	// -- read side (time travel) ---------------------------------------------

	/**
	 * One entity as of a block number.
	 *
	 * Reading by hash or by timestamp resolves to a block number through the
	 * canonical block table and is added on top of this predicate; it is not part
	 * of this module.
	 */
	async getAsOf<T = Record<string, unknown>>(
		entity: string,
		id: EntityId,
		blockNumber: number,
	): Promise<T | undefined> {
		const declaration = mustGet(this.entities, entity);
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

	/** A whole entity table as of a block number. */
	async queryAsOf<T = Record<string, unknown>>(
		entity: string,
		blockNumber: number,
		options: QueryOptions = {},
	): Promise<T[]> {
		const declaration = mustGet(this.entities, entity);
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
