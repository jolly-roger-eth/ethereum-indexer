import type {BlockPointer, EntityDeclaration, Mutation} from '../../src/index.js';

/**
 * The only per-state surface an indexer author writes: `{name, id, fields}`.
 * Everything else (version columns, indexes, as-of rewrite, revert) is generic.
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
 * The ordered child collection keyed by its parent, the shape a bounded listing
 * exists for, with the same declaration the seam's tests use.
 *
 * Its three-column id is what makes a PREFIX worth having: `{epoch}` is one
 * parent's children, `{epoch, position}` is one cell's.
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

export function burn(id: string): Mutation {
	return {type: 'delete', entity: 'token', id: {id}};
}

export function placed(epoch: number, position: number, playerIndex: number, player: string): Mutation {
	return {type: 'upsert', entity: 'placement', id: {epoch, position, playerIndex}, values: {player}};
}
