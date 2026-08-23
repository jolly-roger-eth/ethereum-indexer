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
import {mustGet, normalizeEntities, type StateStore, type StateStoreCapabilities} from '@etherfold/state-store';
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
	 * What this store keeps, and what it can answer, as data a caller reads at
	 * startup rather than inferring from a wrong answer later.
	 *
	 * `unbounded` is the HONEST report, not an aspiration: this package has no
	 * pruning at all, so every version ever written is still here whatever a
	 * deployment might wish. It deliberately takes no retention option, because a
	 * store that accepted a window it cannot enforce would be making exactly the
	 * claim this report exists to prevent. `prune-versions-outside-retention-window`
	 * is what earns the right to report a window, and
	 * `retention-capability-and-refusal` is what makes the report load-bearing by
	 * refusing an out-of-window read.
	 */
	get capabilities(): StateStoreCapabilities {
		return {retention: {kind: 'unbounded'}, asOf: true};
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
	 * those two are not the same news: see `blocks.ts`.
	 */
	async getAsOf<T = Record<string, unknown>>(entity: string, id: EntityId, at: BlockAddress): Promise<T | undefined> {
		const declaration = mustGet(this.entities, entity);
		const blockNumber = await this.resolveForRead(at);
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
	 * A whole entity table as of a block hash, a height, or a timestamp.
	 *
	 * Same resolution and the same "no such block" contract as `getAsOf`: an empty
	 * array means the block is known and nothing matched, while an address that
	 * identifies no block throws.
	 */
	async queryAsOf<T = Record<string, unknown>>(
		entity: string,
		at: BlockAddress,
		options: QueryOptions = {},
	): Promise<T[]> {
		const declaration = mustGet(this.entities, entity);
		const blockNumber = await this.resolveForRead(at);
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
