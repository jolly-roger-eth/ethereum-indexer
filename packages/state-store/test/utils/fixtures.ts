import type {BlockPointer, EntityDeclaration, Mutation} from '../../src/index.js';

/**
 * The only per-state surface an author writes: `{name, id, fields}`. Everything
 * else (versions, as-of reads, revert) is the store's.
 *
 * Deliberately the SAME declarations as `state-store-sqlite/test/utils/fixtures.ts`,
 * so the two backends can be asked identical questions.
 */
export const TOKEN: EntityDeclaration = {
	name: 'token',
	id: ['id'],
	fields: {owner: 'text', transferCount: 'integer'},
};

export const ACCOUNT: EntityDeclaration = {
	name: 'account',
	id: ['address'],
	fields: {balance: 'integer'},
};

/**
 * The ordered child collection, keyed by its parent: the shape a listing exists
 * for.
 *
 * Taken from the real one in `work/notes/findings/sqlite-in-the-browser.md`
 * (contortion 1), where an array of placements per epoch cost three entities
 * plus a hand-maintained CSV index purely because a handler could not ask which
 * rows belong to an epoch. Declared here as the subgraph's `@derivedFrom` shape:
 * the children are their own entity keyed by the parent, and the collection is
 * derived WHEN READ.
 */
export const PLACEMENT: EntityDeclaration = {
	name: 'placement',
	id: ['epoch', 'position', 'playerIndex'],
	fields: {player: 'text'},
};

export function block(
	number: number,
	hash = `0x${number.toString(16)}`,
	timestamp = 1_700_000_000 + number * 12,
): BlockPointer {
	return {number, hash, timestamp};
}

export function owns(id: string, owner: string, transferCount: number): Mutation {
	return {type: 'upsert', entity: 'token', id: {id}, values: {owner, transferCount}};
}
