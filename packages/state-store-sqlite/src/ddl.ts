import {normalizeEntity, type FieldType} from '@etherfold/state-store';
import type {EntityDeclaration, Statement} from './types.js';

/**
 * ## Fixed schema vs dynamic schema (the seam)
 *
 * This repo's convention is that a schema is a static `.sql` file applied by a
 * migration step. That convention holds for FIXED tables, whose shape is known
 * when the code is written, and `_blocks` below is one of them: it is written
 * here as literal SQL, and moves to a `.sql` file the day the server package
 * introduces the codegen step for them.
 *
 * It cannot hold for ENTITY tables. Their columns are whatever a processor
 * declares, which is only known at run time, so their DDL is generated from the
 * declaration. That is the exception, it applies here and nowhere else, and the
 * containment is deliberate: only this module emits DDL, and every identifier it
 * interpolates has been validated by the seam's `normalizeEntity`, which applies
 * this store's identifier rule to EVERY backend so that a declaration is valid
 * or invalid as a fact about the declaration.
 */

/** Block number at which a version became valid (inclusive). */
export const LOWER = '_lower';
/** Block number at which a version stopped being valid (exclusive). NULL = live. */
export const UPPER = '_upper';
/** Surrogate identity of ONE version (a business key has many). */
export const ROWID = '_rowid';

/** The canonical block table: the fixed part of the schema. */
export const BLOCKS_TABLE = '_blocks';

/**
 * Rows exist here only for blocks that carry our logs, not for every chain
 * block: state only changes where our events occur.
 *
 * There is deliberately no `parentHash`. It is not on a log, so recording it
 * would cost the extra `eth_getBlockByHash` round-trip per block that this whole
 * design exists to avoid (ADR-0002 makes the in-browser path primary, and a
 * browser provider cannot even batch those calls). It would also be close to
 * meaningless if it were stored: this table is SPARSE, holding only blocks that
 * carry our logs, so consecutive rows are almost never parent and child and the
 * linkage a `parentHash` implies would not exist to check. The chain-linkage
 * cross-check it would serve (`verifyBlocks`, ADR-0004) is deferred in the
 * design's §9, and if it is ever built it needs the field plumbed onto the log
 * stream first, not reconstructed here.
 */
export const FIXED_SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS ${BLOCKS_TABLE} (
	number INTEGER PRIMARY KEY,
	hash TEXT NOT NULL UNIQUE,
	timestamp INTEGER NOT NULL
)`,
	`CREATE INDEX IF NOT EXISTS ${BLOCKS_TABLE}_timestamp ON ${BLOCKS_TABLE} (timestamp)`,
];

function sqlType(type: FieldType): string {
	switch (type) {
		case 'text':
			return 'TEXT';
		case 'integer':
			return 'INTEGER';
		case 'real':
			return 'REAL';
		case 'blob':
			return 'BLOB';
	}
}

/**
 * The DDL for one entity: the table plus the four indexes the access paths need.
 * The caller writes no SQL, which is the point: `{name, id, fields}` in, a
 * time-travellable table out.
 */
export function ddlForEntity(declaration: EntityDeclaration): string[] {
	const entity = normalizeEntity(declaration);
	const table = entity.name;
	const idList = entity.id.join(', ');

	const columns = [
		`${ROWID} INTEGER PRIMARY KEY AUTOINCREMENT`,
		...entity.id.map((column) => `${column} TEXT NOT NULL`),
		...Object.entries(entity.fields).map(([field, type]) => `${field} ${sqlType(type)}`),
		`${LOWER} INTEGER NOT NULL`,
		// nullable on purpose: NULL is how "still valid at the tip" is expressed.
		// A sentinel such as INT64_MAX would leak into every query and every
		// consumer, and is rejected outright by at least one supported backend.
		`${UPPER} INTEGER`,
	];

	return [
		`CREATE TABLE IF NOT EXISTS ${table} (\n\t${columns.join(',\n\t')}\n)`,
		// The live set, and the invariant SQLite cannot express as a constraint:
		// at most one open version per business key.
		`CREATE UNIQUE INDEX IF NOT EXISTS ${table}_open ON ${table} (${idList}) WHERE ${UPPER} IS NULL`,
		// Time travel: the point as-of probe rides this B-tree, which is why it
		// stays effectively flat as history accumulates.
		`CREATE INDEX IF NOT EXISTS ${table}_history ON ${table} (${idList}, ${LOWER})`,
		// Revert leg A: versions opened above the fork.
		`CREATE INDEX IF NOT EXISTS ${table}_lower ON ${table} (${LOWER})`,
		// Revert leg B: versions closed above the fork.
		`CREATE INDEX IF NOT EXISTS ${table}_upper ON ${table} (${UPPER})`,
	];
}

/**
 * Every statement needed to bring an empty database to the declared shape.
 *
 * All of it is `IF NOT EXISTS`, so it is safe to run on every boot and safe to
 * resume: unlike applying a block, migrating is idempotent and therefore does
 * not need to be one atomic unit.
 */
export function migrationStatements(declarations: Iterable<EntityDeclaration>): Statement[] {
	const sql = [...FIXED_SCHEMA_DDL];
	for (const declaration of declarations) {
		sql.push(...ddlForEntity(declaration));
	}
	return sql.map((statement) => ({sql: statement, args: []}));
}
