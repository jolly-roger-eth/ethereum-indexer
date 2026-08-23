import {entityKey, mustGet} from './entities.js';
import type {StateStore} from './store.js';
import type {EntityId, Mutation} from './types.js';

/**
 * The write surface a handler gets for ONE block.
 *
 * `get` is read-your-writes WITHIN the block being processed: it answers from
 * the mutations already staged for this block, and falls through to the store's
 * current state otherwise. That matters because a handler that increments a
 * counter must see the value an earlier event in the same block wrote, which is
 * the behaviour the in-memory path gets for free by mutating one object. It is
 * load-bearing rather than theoretical: on the real stratagems stream, 16,871 of
 * 66,113 reads were served from the block's own staging area.
 *
 * Blocks below the one being processed are always already flushed, because a
 * block is applied before the next block's handlers run: one block is exactly
 * one atomic unit. So `get` never has to reason about more than the current
 * block.
 *
 * Reads are uniformly async, on every backend. The alternative, typing them as
 * `T | Promise<T>`, is infectious at every call site for the benefit of saving a
 * microtask on a path whose cost is dominated by fetching logs.
 */
export type MutationContext = {
	/** The entity as it stands, including mutations staged earlier in this block. */
	get<T = Record<string, unknown>>(entity: string, id: EntityId): Promise<T | undefined>;
	/**
	 * Write the WHOLE row. Unlisted declared fields become NULL, mirroring the
	 * store's close-then-insert: a version is a complete row, not a delta. To
	 * change one field, use `update`.
	 */
	set(entity: string, id: EntityId, values: Record<string, unknown>): void;
	/**
	 * Sugar, and nothing more: `get`, spread, `set`.
	 *
	 * It is spelled as sugar rather than as a second primitive so the storage
	 * model stays visible. A partial write still opens a complete new version;
	 * there is no such thing as writing one column of a version.
	 */
	update(entity: string, id: EntityId, values: Record<string, unknown>): Promise<void>;
	/** Close the live version without opening a new one: absent from this block on, readable before it. */
	delete(entity: string, id: EntityId): void;
};

/** A staging area for one block, plus the mutations it has collected. */
export type StagedBlock = {
	/** What the handlers are handed. Named `state` because that is the handler's parameter. */
	state: MutationContext;
	/**
	 * The block's mutations, COALESCED per business key in first-touch order.
	 *
	 * Emitting every write would be correct but would leave zero-width versions
	 * (`_lower === _upper`) that no as-of read can ever match, so it would grow
	 * the store with rows that are invisible by construction.
	 */
	mutations(): Mutation[];
};

/**
 * Open a staging area over a store, for exactly one block.
 *
 * This is implemented ONCE, above the backend interface, which is why
 * read-your-writes is a property of the seam rather than of whichever store is
 * wired in. A backend cannot get it subtly wrong because a backend does not
 * implement it.
 */
export function createMutationContext(store: StateStore): StagedBlock {
	const pending = new Map<string, Mutation>();
	const keyOf = (entity: string, id: EntityId): string => entityKey(mustGet(store.declarations, entity), id);

	const context: MutationContext = {
		get: async <T>(entity: string, id: EntityId): Promise<T | undefined> => {
			const staged = pending.get(keyOf(entity, id));
			if (staged) {
				return staged.type === 'delete' ? undefined : ({...staged.values} as T);
			}
			return store.getCurrent<T>(entity, id);
		},
		set: (entity: string, id: EntityId, values: Record<string, unknown>): void => {
			pending.set(keyOf(entity, id), {type: 'upsert', entity, id, values});
		},
		update: async (entity: string, id: EntityId, values: Record<string, unknown>): Promise<void> => {
			const declaration = mustGet(store.declarations, entity);
			const current = await context.get<Record<string, unknown>>(entity, id);
			// only DECLARED fields survive the spread: `get` answers with the row as
			// the store holds it, which on a versioned backend carries the version
			// columns, and those must not travel back in as values.
			const merged: Record<string, unknown> = {};
			for (const field of Object.keys(declaration.fields)) {
				if (current && field in current) merged[field] = current[field];
			}
			context.set(entity, id, {...merged, ...values});
		},
		delete: (entity: string, id: EntityId): void => {
			pending.set(keyOf(entity, id), {type: 'delete', entity, id});
		},
	};

	return {state: context, mutations: () => [...pending.values()]};
}
