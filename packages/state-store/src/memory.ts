import {normalizeBlockHash} from './blocks.js';
import type {StateStoreCapabilities} from './capabilities.js';
import {entityKey, idValues, mustGet, normalizeEntities} from './entities.js';
import type {StateStore} from './store.js';
import type {BlockPointer, EntityDeclaration, EntityId, Mutation, NormalizedEntity} from './types.js';

/** One version of one entity: a complete row plus its half-open validity range. */
type Version = {values: Record<string, unknown>; lower: number; upper: number | null};

/**
 * The reference `StateStore`: versioned rows in a Map.
 *
 * It is here for two reasons and neither of them is production use. A contract
 * with no runnable implementation is a document, not a specification, so this is
 * the executable one; and "a processor runs unchanged on two backends" needs a
 * second backend that owes nothing to SQL to be worth asserting.
 *
 * Its behaviour matches `@etherfold/state-store-sqlite` DOWN TO THE SHARP EDGES,
 * on purpose. Re-applying a block raises here as it does there (a primary-key
 * violation), an unlisted declared field goes to NULL here as it does there, and
 * a business key is stringified here as it is there. A lenient reference
 * implementation would be worse than none: it would let a caller bug through in
 * a test and surface it in production.
 *
 * What it is NOT: bounded. It keeps every version for as long as the process
 * lives, which is why it reports `unbounded` honestly and why it is unsuitable
 * as a browser backend (`indexeddb-row-backend-browser-default` is that).
 */
export class MemoryStateStore implements StateStore {
	private readonly entities: ReadonlyMap<string, NormalizedEntity>;
	/** entity key -> versions, oldest first. */
	private readonly versions = new Map<string, Version[]>();
	private readonly blocks = new Map<number, BlockPointer>();
	private readonly hashes = new Map<string, number>();

	constructor(declarations: Iterable<EntityDeclaration>) {
		this.entities = normalizeEntities(declarations);
	}

	get declarations(): ReadonlyMap<string, NormalizedEntity> {
		return this.entities;
	}

	/**
	 * Everything, forever, and it answers history: the honest report for a store
	 * that never prunes.
	 */
	get capabilities(): StateStoreCapabilities {
		return {retention: {kind: 'unbounded'}, asOf: true};
	}

	/** Nothing to create: the shape is the declaration, and it is already validated. */
	async migrate(): Promise<void> {}

	/**
	 * Apply one block, all of it or none of it.
	 *
	 * Every mutation is resolved against the declarations BEFORE anything is
	 * written, so a mutation naming an entity that was never declared leaves the
	 * store exactly as it found it. That mirrors the SQL store, where one block
	 * is one batch and therefore one transaction.
	 */
	async applyBlock(block: BlockPointer, mutations: readonly Mutation[] = []): Promise<void> {
		const hash = normalizeBlockHash(block.hash);
		if (this.blocks.has(block.number)) {
			throw new Error(
				`block ${block.number} is already recorded: applying the same block twice is a caller bug, ` +
					`and a reorged height must be reverted before its replacement is applied.`,
			);
		}
		if (this.hashes.has(hash)) {
			throw new Error(`block hash ${hash} is already recorded, at height ${this.hashes.get(hash)}.`);
		}

		const planned = mutations.map((mutation) => {
			const entity = mustGet(this.entities, mutation.entity);
			return {mutation, entity, key: entityKey(entity, mutation.id), id: idValues(entity, mutation.id)};
		});

		this.blocks.set(block.number, {...block, hash});
		this.hashes.set(hash, block.number);

		for (const {mutation, entity, key, id} of planned) {
			const versions = this.versions.get(key) ?? [];
			if (versions.length === 0) this.versions.set(key, versions);

			const live = versions.find((version) => version.upper === null);
			if (live) live.upper = block.number;

			if (mutation.type === 'upsert') {
				const values: Record<string, unknown> = {};
				entity.id.forEach((column, index) => (values[column] = id[index]));
				// a version is a COMPLETE row: a declared field the mutation did not
				// list is written as NULL, not left at its previous value.
				for (const field of Object.keys(entity.fields)) {
					values[field] = mutation.values?.[field] ?? null;
				}
				versions.push({values, lower: block.number, upper: null});
			}
		}
	}

	async getCurrent<T = Record<string, unknown>>(entity: string, id: EntityId): Promise<T | undefined> {
		return this.read<T>(entity, id, (version) => version.upper === null);
	}

	async getAsOf<T = Record<string, unknown>>(entity: string, id: EntityId, at: number): Promise<T | undefined> {
		return this.read<T>(entity, id, (version) => version.lower <= at && (version.upper === null || at < version.upper));
	}

	/**
	 * Drop versions opened above the fork, then re-open the ones it closed.
	 *
	 * The same two moves the SQL store makes, in the same order and for the same
	 * reason: a version the dead branch closed must become live again, and it can
	 * only do so once the dead branch's own version is gone, or two versions of
	 * one business key would be open at once.
	 */
	async revertTo(keepUpTo: number): Promise<void> {
		for (const [key, versions] of this.versions) {
			const kept = versions.filter((version) => version.lower <= keepUpTo);
			for (const version of kept) {
				if (version.upper !== null && version.upper > keepUpTo) version.upper = null;
			}
			if (kept.length === 0) this.versions.delete(key);
			else this.versions.set(key, kept);
		}
		for (const [number, block] of this.blocks) {
			if (number > keepUpTo) {
				this.blocks.delete(number);
				this.hashes.delete(block.hash);
			}
		}
	}

	/**
	 * The block recorded at a height, or `undefined`.
	 *
	 * Not part of `StateStore`: addressing state by hash or by time (and refusing
	 * an address that resolves to nothing) is the read layer above the seam. This
	 * is here so a test can see what was recorded.
	 */
	async getBlock(number: number): Promise<BlockPointer | undefined> {
		const block = this.blocks.get(number);
		return block && {...block};
	}

	private read<T>(entity: string, id: EntityId, matches: (version: Version) => boolean): T | undefined {
		const declaration = mustGet(this.entities, entity);
		const versions = this.versions.get(entityKey(declaration, id)) ?? [];
		const found = versions.find(matches);
		return found && ({...found.values, _lower: found.lower, _upper: found.upper} as T);
	}
}
