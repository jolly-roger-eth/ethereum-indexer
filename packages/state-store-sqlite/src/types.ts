/**
 * The declaration surface an indexer author writes, and nothing more.
 *
 * `{name, id, fields}` is the whole per-entity contract: the store owns the
 * version columns, the DDL, the as-of rewrite and the reorg revert. That is the
 * subgraph ergonomic property this design is after: history falls out of a
 * schema instead of being re-implemented by every processor.
 */

/** SQLite storage classes an entity field may declare. */
export type ColumnType = 'text' | 'integer' | 'real' | 'blob';

export type EntityDeclaration = {
	/** table name, e.g. `token` */
	name: string;
	/**
	 * The BUSINESS key columns (e.g. `['id']`, or several for a composite key).
	 * Not the version key: a single business key has many versions over time.
	 */
	id: string | readonly string[];
	/** data columns, excluding the business key, and their storage class */
	fields: Readonly<Record<string, ColumnType>>;
};

/** An entity declaration after validation, with `id` always a list. */
export type NormalizedEntity = {
	name: string;
	id: readonly string[];
	fields: Readonly<Record<string, ColumnType>>;
};

/**
 * A block, as recorded in the canonical block table.
 *
 * `timestamp` is seconds since the epoch, as the chain reports it, and it is a
 * NUMBER here on purpose: `blockTimestamp` arrives off a log as hex from most
 * clients and as decimal from at least one, so it is normalised once at the
 * ingestion seam (`normalizeBlockTimestamp`) rather than being guessed at by
 * every reader. `hash` is folded to lower case on write, since it is the
 * identity consumers pin and look up again (`normalizeBlockHash`).
 *
 * There is no `parentHash`, and its absence is a decision rather than an
 * omission: it is not on a log, so it would cost a round-trip per block, and it
 * would describe a linkage this sparse table does not have. See `ddl.ts`.
 *
 * Reading state back out as of a hash, a height or a timestamp is `blocks.ts`.
 */
export type BlockPointer = {
	number: number;
	hash: string;
	timestamp: number;
};

/** A business-key value: the columns named by the entity's `id`. */
export type EntityId = Record<string, string | number>;

/**
 * What a processor produced for one block.
 *
 * An `upsert` closes the live version and opens a new one; a `delete` is only
 * the close, so the entity is absent from that block onward while remaining
 * fully readable as of any earlier block.
 */
export type Mutation =
	| {type: 'upsert'; entity: string; id: EntityId; values: Record<string, unknown>}
	| {type: 'delete'; entity: string; id: EntityId};

/** One block and the mutations to apply with it, as one atomic unit. */
export type BlockUpdate = {block: BlockPointer; mutations: Mutation[]};

/**
 * A statement before it is prepared.
 *
 * Statements are built as plain data so they can be counted, sized and grouped
 * into batches before any of them touches the database, and so the ordering
 * inside a batch can be asserted by a test.
 */
export type Statement = {sql: string; args: unknown[]};
