/**
 * `MutationContext` over a staging area for ONE block.
 *
 * Two properties are load-bearing and both come straight from the spec:
 *
 *   - READ-YOUR-WRITES within the block. `get` answers from what earlier events
 *     in this block staged, and only falls through to the store otherwise. The
 *     stratagems port would be wrong without it: `computeMove` reads back cells
 *     that a previous move in the same reveal wrote.
 *   - ONE VERSION PER ROW PER BLOCK. Writing the same row twice in a block
 *     collapses to a single mutation (last write wins), because a version is
 *     defined by the block it belongs to. That is not an optimisation, it is
 *     what makes an as-of read by block number well defined.
 */
import type {MutationContext} from '../../../../packages/processor-sqlite/dist/index.js';
import {rowKey, type EntityId, type Mutation} from './types.js';

export type BlockMutations = {
	ctx: MutationContext;
	mutations(): Mutation[];
	/** How many times a handler read through to the store, versus from the staging area. */
	stats(): {reads: number; stagedReads: number; writes: number; deletes: number};
};

export function createBlockMutations(
	read: (entity: string, id: EntityId) => Promise<Record<string, unknown> | undefined>,
): BlockMutations {
	const staged = new Map<string, Mutation>();
	let reads = 0;
	let stagedReads = 0;
	let writes = 0;
	let deletes = 0;

	const ctx: MutationContext = {
		async get<T = Record<string, unknown>>(entity: string, id: EntityId): Promise<T | undefined> {
			const key = rowKey(entity, id);
			const pending = staged.get(key);
			if (pending) {
				stagedReads++;
				return (pending.type === 'upsert' ? (pending.values as T) : undefined) as T | undefined;
			}
			reads++;
			return (await read(entity, id)) as T | undefined;
		},
		set(entity: string, id: EntityId, values: Record<string, unknown>): void {
			writes++;
			staged.set(rowKey(entity, id), {type: 'upsert', entity, id, values});
		},
		delete(entity: string, id: EntityId): void {
			deletes++;
			staged.set(rowKey(entity, id), {type: 'delete', entity, id});
		},
	};

	return {
		ctx,
		mutations: () => [...staged.values()],
		stats: () => ({reads, stagedReads, writes, deletes}),
	};
}
