import type {
	BlockAddress,
	EntityId,
	EntityIdPrefix,
	Listing,
	QueryOptions,
	RecordedBlock,
	StateStoreCapabilities,
	VersionedStateStore,
} from '@etherfold/state-store-sqlite';

/**
 * ## What `process` returns, given that the state is a database
 *
 * The `EventProcessor` contract is
 * `process(eventStream, lastSync) => ProcessResultType`, shaped for a processor
 * whose state is an in-memory object it can simply hand back. Materialising a
 * versioned store into such an object would defeat the entire point: the store
 * exists so that "state at block N" is an index probe rather than something held
 * in memory, and it can hold more history than fits there.
 *
 * The core settles the question. `indexer.ts` never inspects the value: the
 * outcome of `process` and the `state` from `load` go to `_onStateUpdated`,
 * which forwards them to the optional `onStateUpdated` callback and nothing
 * else. The engine's own decisions are driven by `lastSync`. So the return value
 * is purely a channel to the consumer, and the question is what the consumer
 * most usefully receives.
 *
 * `void` would type-check and would be a lie by omission: a consumer notified
 * that the state changed with no way to read it has to have been handed a
 * database elsewhere. A query handle is O(1) to produce, has stable identity
 * across every call, and says exactly what it is.
 *
 * It is READ-ONLY on purpose. Handing back the `VersionedStateStore` itself
 * would put `applyBlock` and `revertTo` in the hands of a UI callback, where a
 * stray call corrupts the chain of versions with no way to tell afterwards. The
 * writer is the processor, and it is the only writer.
 */
export class VersionedStateView {
	constructor(private readonly store: VersionedStateStore) {}

	/**
	 * What history this state can answer about, readable before anything is asked
	 * of it.
	 *
	 * This is the point of the report being on the read handle: a consumer that
	 * needs as-of reads discovers at startup whether they are available, instead
	 * of discovering it from a refusal in production or, worse, from a plausible
	 * wrong number.
	 */
	get capabilities(): StateStoreCapabilities {
		return this.store.capabilities;
	}

	/**
	 * One entity as of a block hash, a height, or a timestamp.
	 *
	 * `undefined` means the block is known and the entity was absent from it. An
	 * address identifying no block throws `NoSuchBlockError` instead (ADR-0015):
	 * a hash that no longer resolves is the signal that a consumer's pinned block
	 * was reorged out, and it must not arrive wearing "entity absent" as a
	 * disguise. A block outside the retention this view reports throws
	 * `BlockNotRetainedError`, the other member of that family.
	 */
	getAsOf<T = Record<string, unknown>>(entity: string, id: EntityId, at: BlockAddress): Promise<T | undefined> {
		return this.store.getAsOf<T>(entity, id, at);
	}

	/** One entity at the tip. */
	getCurrent<T = Record<string, unknown>>(entity: string, id: EntityId): Promise<T | undefined> {
		return this.store.getCurrent<T>(entity, id);
	}

	/**
	 * The rows whose declared id starts with `prefix`, at the tip, ascending, at
	 * most `limit` of them, with `truncated` saying whether more matched.
	 *
	 * This is the seam's one SET read, and it is here because it is how a
	 * one-to-many is meant to be read: children keyed by their parent, derived
	 * when read. Without it a consumer holding this handle reaches the same rows
	 * through `queryCurrent` and a hand-written `WHERE`, which is the surface the
	 * bounded listing exists to make unnecessary (ADR-0021).
	 */
	listCurrent<T = Record<string, unknown>>(entity: string, prefix: EntityIdPrefix, limit: number): Promise<Listing<T>> {
		return this.store.listCurrent<T>(entity, prefix, limit);
	}

	/**
	 * The same listing as of a block hash, a height, or a timestamp: the children
	 * that were live then.
	 *
	 * Same two refusals as `getAsOf`, for the same reason: an address that
	 * identifies no block throws `NoSuchBlockError` and a block outside this
	 * view's retention throws `BlockNotRetainedError`, rather than either being
	 * served from the tip. An EMPTY listing means the block is known and the
	 * prefix had no children then.
	 */
	listAsOf<T = Record<string, unknown>>(
		entity: string,
		prefix: EntityIdPrefix,
		at: BlockAddress,
		limit: number,
	): Promise<Listing<T>> {
		return this.store.listAsOf<T>(entity, prefix, at, limit);
	}

	/** A whole entity table as of a block hash, a height, or a timestamp. */
	queryAsOf<T = Record<string, unknown>>(entity: string, at: BlockAddress, options?: QueryOptions): Promise<T[]> {
		return this.store.queryAsOf<T>(entity, at, options);
	}

	/** A whole entity table at the tip. */
	queryCurrent<T = Record<string, unknown>>(entity: string, options?: QueryOptions): Promise<T[]> {
		return this.store.queryCurrent<T>(entity, options);
	}

	/**
	 * The recorded block an address identifies, or `undefined`.
	 *
	 * This is how "pin the hash" becomes actionable: resolve by height or time
	 * once, keep the `hash` that comes back, and a later reorg answers loudly.
	 */
	getBlock(address: BlockAddress): Promise<RecordedBlock | undefined> {
		return this.store.getBlock(address);
	}

	/** The soft resolution: a block number, or `undefined`, never a throw. */
	resolveBlockNumber(address: BlockAddress): Promise<number | undefined> {
		return this.store.resolveBlockNumber(address);
	}
}
