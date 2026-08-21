import {normalizeBlockHash} from './blocks.js';
import {BLOCKS_TABLE, LOWER, UPPER} from './ddl.js';
import {mustGet, normalizeEntities} from './internal/identifiers.js';
import type {BlockPointer, EntityDeclaration, EntityId, Mutation, NormalizedEntity, Statement} from './types.js';

/**
 * The SQL of the store, built as plain data.
 *
 * These are pure functions on purpose. The ordering inside a batch is
 * load-bearing (see `revertToStatements`), and a test can only pin an ordering
 * it can see.
 */

/** `_lower <= N AND (_upper IS NULL OR N < _upper)` — the whole of time travel. */
export const AS_OF_PREDICATE = `${LOWER} <= ? AND (${UPPER} IS NULL OR ? < ${UPPER})`;

/** The live version: the open-row special case, served by the partial index. */
export const CURRENT_PREDICATE = `${UPPER} IS NULL`;

/** The columns of one recorded block, in `RecordedBlock` order. */
const BLOCK_COLUMNS = 'number, hash, parentHash, timestamp';

/**
 * Look a block up by hash: the reorg-proof axis.
 *
 * `hash` is UNIQUE, so this is a one-row index probe, and an empty result means
 * "no such block" rather than "no such entity" (see `blocks.ts`).
 */
export function blockByHashStatement(hash: string): Statement {
	return {sql: `SELECT ${BLOCK_COLUMNS} FROM ${BLOCKS_TABLE} WHERE hash = ? LIMIT 1`, args: [normalizeBlockHash(hash)]};
}

/** Look a block up by height. Only recorded blocks have a row; heights need none. */
export function blockByNumberStatement(number: number): Statement {
	return {sql: `SELECT ${BLOCK_COLUMNS} FROM ${BLOCKS_TABLE} WHERE number = ? LIMIT 1`, args: [number]};
}

/**
 * The latest recorded block at or before `timestamp`, riding the timestamp index.
 *
 * `number DESC` breaks a tie rather than leaving it to the engine: several
 * blocks may carry the same timestamp (an L2 issuing more than one block per
 * second, or a chain that repeats one), and the answer must be the LATEST state
 * at that instant, deterministically.
 *
 * Nothing at or before T resolves to no row, never to the first recorded block:
 * the state before we started indexing is not the state at our first block.
 */
export function blockAtOrBeforeStatement(timestamp: number): Statement {
	return {
		sql: `SELECT ${BLOCK_COLUMNS} FROM ${BLOCKS_TABLE} WHERE timestamp <= ? ORDER BY timestamp DESC, number DESC LIMIT 1`,
		args: [timestamp],
	};
}

export function idPredicate(entity: NormalizedEntity): string {
	return entity.id.map((column) => `${column} = ?`).join(' AND ');
}

export function idValues(entity: NormalizedEntity, id: EntityId): string[] {
	return entity.id.map((column) => {
		const value = id?.[column];
		if (value === undefined || value === null) {
			throw new Error(`entity ${entity.name} requires an id column ${column}, got ${JSON.stringify(value)}`);
		}
		return String(value);
	});
}

/**
 * The statements that apply ONE block. The caller sends them as one batch: the
 * block row and every entity mutation land together or not at all.
 *
 * A write is close-then-insert:
 *   1. `UPDATE ... SET _upper = N WHERE <id> AND _upper IS NULL` closes the live
 *      version at this height, and
 *   2. `INSERT ... (_lower = N)` opens the new one.
 * A delete is step 1 alone.
 *
 * The block row is inserted plainly rather than upserted: applying the same
 * block twice is a bug in the caller, and a primary-key violation says so
 * immediately instead of silently double-writing versions.
 */
export function applyBlockStatements(
	declarations: Iterable<EntityDeclaration> | ReadonlyMap<string, NormalizedEntity>,
	block: BlockPointer,
	mutations: readonly Mutation[],
): Statement[] {
	const entities = asEntityMap(declarations);
	const statements: Statement[] = [
		{
			sql: `INSERT INTO ${BLOCKS_TABLE} (number, hash, parentHash, timestamp) VALUES (?, ?, ?, ?)`,
			// the hash is folded to one spelling here, since it is the identity a
			// consumer pins and later looks up (see `normalizeBlockHash`).
			args: [block.number, normalizeBlockHash(block.hash), block.parentHash ?? '', block.timestamp],
		},
	];

	for (const mutation of mutations) {
		const entity = mustGet(entities, mutation.entity);
		const table = entity.name;
		const values = idValues(entity, mutation.id);

		// (1) close the live version at this height
		statements.push({
			sql: `UPDATE ${table} SET ${UPPER} = ? WHERE ${idPredicate(entity)} AND ${UPPER} IS NULL`,
			args: [block.number, ...values],
		});

		if (mutation.type === 'upsert') {
			// (2) open the new one
			const fields = Object.keys(entity.fields);
			const columns = [...entity.id, ...fields, LOWER];
			statements.push({
				sql: `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
				args: [...values, ...fields.map((field) => mutation.values?.[field] ?? null), block.number],
			});
		}
	}

	return statements;
}

/**
 * The statements that roll the state back to `keepUpTo`, in the ONLY order that
 * works.
 *
 * Per entity table:
 *   A) `DELETE FROM t WHERE _lower > :keepUpTo` — versions born on the dead
 *      branch, which never existed on the canonical one.
 *   B) `UPDATE t SET _upper = NULL WHERE _upper > :keepUpTo` — versions the dead
 *      branch closed, which must be live again.
 * Then the dead blocks leave the canonical block table, so a hash that has been
 * reorged out stops resolving.
 *
 * **A MUST run before B.** SQLite enforces the partial unique index
 * `(id) WHERE _upper IS NULL` per statement; there is no deferred mode. Re-open
 * first and the re-opened row collides with the dead-branch row that is still
 * present, both open for the same business key: SQLITE_CONSTRAINT_UNIQUE.
 * Deleting the dead branch first removes that row, so the re-open is
 * conflict-free.
 *
 * This is not a stylistic ordering and it is not safe to "tidy up". Both
 * directions are pinned by `test/revert-order.test.ts`, executed against a real
 * SQLite engine, because that is the only thing that catches it.
 */
export function revertToStatements(
	declarations: Iterable<EntityDeclaration> | ReadonlyMap<string, NormalizedEntity>,
	keepUpTo: number,
): Statement[] {
	const entities = asEntityMap(declarations);
	const statements: Statement[] = [];

	for (const entity of entities.values()) {
		// A) drop versions opened above the fork (this clears their open rows)
		statements.push({sql: `DELETE FROM ${entity.name} WHERE ${LOWER} > ?`, args: [keepUpTo]});
		// B) re-open versions closed above the fork
		statements.push({sql: `UPDATE ${entity.name} SET ${UPPER} = NULL WHERE ${UPPER} > ?`, args: [keepUpTo]});
	}

	statements.push({sql: `DELETE FROM ${BLOCKS_TABLE} WHERE number > ?`, args: [keepUpTo]});
	return statements;
}

function asEntityMap(
	declarations: Iterable<EntityDeclaration> | ReadonlyMap<string, NormalizedEntity>,
): ReadonlyMap<string, NormalizedEntity> {
	return declarations instanceof Map ? declarations : normalizeEntities(declarations as Iterable<EntityDeclaration>);
}
