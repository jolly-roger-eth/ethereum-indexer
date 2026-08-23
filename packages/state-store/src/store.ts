import type {StateStoreCapabilities} from './capabilities.js';
import type {EntityIdPrefix, Listing} from './listing.js';
import type {PruneOptions, PruneReport} from './retention.js';
import type {BlockPointer, EntityId, Mutation, NormalizedEntity} from './types.js';

/**
 * The seam: what a store must do for a processor to run on it.
 *
 * Eight verbs and one report, chosen because they are the whole of what
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
 * The listing is the one SET read, and its BOUND is what keeps it cheap
 * everywhere: a prefix of the declared id plus a required limit, never a
 * predicate and never a caller-supplied ordering (see `listing.ts`).
 *
 * Deliberately absent, and each absence is a decision:
 *
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

	/**
	 * Delete the versions the declared retention no longer covers, and report what
	 * went.
	 *
	 * **It is an EXPLICIT call, and that placement is the decision.** The window
	 * bounds what a read may ask about at all times, whether or not this ever runs;
	 * what this adds is the other half, bounding the BYTES. It is deliberately not
	 * a side effect of `applyBlock`, because a prune costs real time (1.1 s at
	 * 62,553 versions, measured in
	 * `work/notes/findings/sqlite-in-the-browser.md`) and a block carries a median
	 * of 7 mutations, so folding it in would stall whichever block happened to
	 * cross a threshold by a second for work that block did not ask for. Which
	 * block pays, and how often, is the host's scheduling decision, and a store is
	 * the wrong place to invent one. An amortised policy is `maxVersions` on a
	 * schedule; a background policy is this call on a timer. Both are built ON this
	 * verb rather than instead of it.
	 *
	 * The caller is the writer: a store has one, and pruning between blocks is safe
	 * exactly where applying a block is.
	 *
	 * Pruning a store that has no floor to prune at (`unbounded`, or `revert-only`
	 * with no declared finality depth) is a NO-OP and never an error: "keep
	 * everything" is a legitimate answer to "drop what is unreachable", and a host
	 * that prunes on a timer must not have to ask what it is holding first.
	 *
	 * The LIVE version of an entity is never dropped, however old it is. A row
	 * written once at block 12,082,307 and never touched again is still the current
	 * state, and deleting by age alone destroys it (see `retentionFloor`).
	 */
	prune(options?: PruneOptions): Promise<PruneReport>;

	/** One entity as it stands at the tip. */
	getCurrent<T = Record<string, unknown>>(entity: string, id: EntityId): Promise<T | undefined>;

	/**
	 * The rows whose declared id starts with `prefix`, at the tip, in ascending
	 * id order, at most `limit` of them.
	 *
	 * This is the derived collection a one-to-many is read through, and the
	 * REQUIRED limit is the whole reason it can be asked of any backend: the
	 * operation is a key-prefix range with a bound, which is an indexed range scan
	 * on every substrate. `truncated` says whether more matched, because a set that
	 * exactly fills the limit is otherwise indistinguishable from a cut-off one.
	 */
	listCurrent<T = Record<string, unknown>>(entity: string, prefix: EntityIdPrefix, limit: number): Promise<Listing<T>>;

	/**
	 * The same listing as of a block NUMBER: the children that were live then.
	 *
	 * Refused, not answered from the tip, by a store whose retention does not
	 * cover that block -- the same contract as `getAsOf`, for the same reason.
	 */
	listAsOf<T = Record<string, unknown>>(
		entity: string,
		prefix: EntityIdPrefix,
		at: number,
		limit: number,
	): Promise<Listing<T>>;

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
