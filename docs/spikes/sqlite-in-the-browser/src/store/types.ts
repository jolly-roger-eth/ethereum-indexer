/**
 * The seam every candidate backend implements, and the trace they all replay.
 *
 * It is deliberately the same shape as `@etherfold/state-store-sqlite`'s
 * `applyBlock` / `getAsOf` / `revertTo`, because that IS the seam the spec
 * places `MutationContext` above: measuring anything narrower would be
 * measuring a benchmark rather than the thing that would ship.
 */
export type EntityId = Record<string, string | number>;

export type Mutation =
	| {type: 'upsert'; entity: string; id: EntityId; values: Record<string, unknown>}
	| {type: 'delete'; entity: string; id: EntityId};

export type BlockPointer = {number: number; hash: string; timestamp: number};

/** One block and everything it changed: the unit that is applied, and the unit that is timed. */
export type BlockUpdate = {block: BlockPointer; mutations: Mutation[]};

/** What a backend says it can answer, per the spec's "retention is a declared capability". */
export type Retention = {kind: 'revert-only'} | {kind: 'window'; blocks: number} | {kind: 'unbounded'};

export interface BlockStore {
	readonly name: string;
	readonly retention: Retention;
	open(): Promise<void>;
	/** One block is ONE batch. Applying a block must be atomic and must not be split. */
	applyBlock(update: BlockUpdate): Promise<void>;
	/** The current value, at the tip. */
	get(entity: string, id: EntityId): Promise<Record<string, unknown> | undefined>;
	/** The value as of a block number, or a refusal if the backend does not retain that far. */
	getAsOf(entity: string, id: EntityId, blockNumber: number): Promise<Record<string, unknown> | undefined>;
	/** Undo every block above `blockNumber`. */
	revertTo(blockNumber: number): Promise<void>;
	close(): Promise<void>;
}

/** A backend that cannot serve a historical read says so, rather than answering from the tip. */
export class RetentionUnavailableError extends Error {
	constructor(backend: string, blockNumber: number, retention: Retention) {
		super(`${backend} cannot answer as of block ${blockNumber}: retention is ${JSON.stringify(retention)}`);
		this.name = 'RetentionUnavailableError';
	}
}

/**
 * A stable key for an entity id.
 *
 * Values are stringified, so `{epoch: 19795}` and `{epoch: '19795'}` are the
 * same row. That is a prototype simplification and it is the RIGHT default for
 * a comparison (SQLite would apply its own type affinity), but a real backend
 * has to decide it deliberately rather than inherit it from a `String()` call.
 */
export function idKey(id: EntityId): string {
	const keys = Object.keys(id).sort();
	return keys.map((key) => `${key}=${String(id[key])}`).join('|');
}

export function rowKey(entity: string, id: EntityId): string {
	return `${entity}\u0000${idKey(id)}`;
}
