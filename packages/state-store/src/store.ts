import type {StateStoreCapabilities} from './capabilities.js';
import type {BlockPointer, EntityId, Mutation, NormalizedEntity} from './types.js';

/**
 * The seam: what a store must do for a processor to run on it.
 *
 * Five verbs and one report, chosen because they are the whole of what
 * processing a chain needs and because each of them is cheaply implementable on
 * every substrate we have measured (versioned SQL rows, an object store, an
 * in-memory map, a patch log). Anything a particular backend can do BETTER stays
 * on that backend's own class: `@etherfold/state-store-sqlite` keeps a richer
 * query surface (`queryCurrent` / `queryAsOf`, with caller-supplied SQL) and
 * block addressing by hash and time, because a server has a query planner and a
 * handler does not.
 *
 * The direction of the constraint is what makes this work: the mutation surface
 * a handler writes through is the MORE constrained one, so a freer substrate can
 * implement it, while backing arbitrary nested object mutation with versioned
 * rows cannot be done without materialising the store.
 *
 * Deliberately absent, and each absence is a decision:
 *
 * - **A listing.** `bounded-id-prefix-listing` adds the one read the model is
 *   missing (rows whose declared id starts with a prefix, with a required
 *   limit). It is not here because the bound is a design decision that task
 *   owns, not because a listing does not belong at the seam.
 * - **Block addressing by hash or time.** `getAsOf` takes a resolved block
 *   NUMBER, so the seam owes nothing to a block table. Resolving a hash or a
 *   timestamp to a number, and refusing an address that resolves to nothing
 *   (`NoSuchBlockError`, ADR-0015), is the read layer above.
 * - **The sync cursor.** Where a processor keeps `LastSync` is the processor
 *   package's business (ADR-0016), and putting it here would make every backend
 *   implement it to serve one caller.
 */
export interface StateStore {
	/** What this store keeps and what it can answer. Readable before `migrate`. */
	readonly capabilities: StateStoreCapabilities;

	/** The declared entities, after validation. */
	readonly declarations: ReadonlyMap<string, NormalizedEntity>;

	/**
	 * Bring the storage to the declared shape. Idempotent, so it is safe on every
	 * boot.
	 */
	migrate(): Promise<void>;

	/**
	 * Apply one block: the block itself plus every mutation, as ONE atomic unit.
	 *
	 * Which blocks get recorded is the CALLER's judgement: every block handed
	 * over is recorded, including one that carried no mutation, and nothing else
	 * is. A block that carries a log of ours which changes nothing is still a
	 * block a consumer can legitimately pin.
	 */
	applyBlock(block: BlockPointer, mutations?: readonly Mutation[]): Promise<void>;

	/** One entity as it stands at the tip. */
	getCurrent<T = Record<string, unknown>>(entity: string, id: EntityId): Promise<T | undefined>;

	/**
	 * One entity as of a block NUMBER.
	 *
	 * `undefined` means the entity was absent at that block. A store that cannot
	 * answer historical reads at all reports `asOf: false` and refuses rather
	 * than answering from the tip.
	 */
	getAsOf<T = Record<string, unknown>>(entity: string, id: EntityId, at: number): Promise<T | undefined>;

	/**
	 * Roll the state back to `keepUpTo`, dropping everything above it.
	 *
	 * Afterwards the store IS the state as of `keepUpTo`: versions opened above
	 * the fork are gone and versions the dead branch closed are live again, so a
	 * counter that a reorged block incremented goes back DOWN. That is the
	 * canonical bug this design exists to make impossible.
	 */
	revertTo(keepUpTo: number): Promise<void>;
}
