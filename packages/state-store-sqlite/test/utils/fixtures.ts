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

export function block(
	number: number,
	hash = `0x${number.toString(16)}`,
	timestamp = 1_700_000_000 + number * 12,
): BlockPointer {
	return {number, hash, parentHash: `0x${(number - 1).toString(16)}`, timestamp};
}

export function owns(id: string, owner: string, transferCount: number): Mutation {
	return {type: 'upsert', entity: 'token', id: {id}, values: {owner, transferCount}};
}

export function burn(id: string): Mutation {
	return {type: 'delete', entity: 'token', id: {id}};
}
