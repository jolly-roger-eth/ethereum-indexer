import {normalizeEntity, type FieldType} from '@etherfold/state-store';
import {assertStorableEntityNames, quoted, quotedList} from './identifiers.js';
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
 * or invalid as a fact about the declaration. Every one of them is also QUOTED
 * on the way out (`quoted`, `identifiers.ts`), because a validated SHAPE can
 * still be a SQL keyword and this backend must accept exactly what the seam
 * accepts.
 *
 * ## Why the derived index names carry the store's `_` prefix
 *
 * In SQLite an index and a table share ONE namespace, so an index named
 * `token_open` and a table named `token_open` cannot both exist. Deriving an
 * index name from an entity name without a prefix therefore put this store's
 * OWN names into the space a declaration draws from: declaring `token` and
 * `token_open` together was accepted by the seam, stored as two entities by
 * every other backend, and killed `migrate()` here with
 * `SQLITE_ERROR: there is already an index named token_open` (or
 * `...already a table named...`, depending which was created first).
 *
 * Prefixing with `_` fixes it by CONSTRUCTION rather than by a new refusal, and
 * that is the point: the seam already reserves the `_` prefix for the store, so
 * no declaration can reach into `_token_open` and no entity name has to be
 * refused for a reason that would be nonsense on a backend with no indexes in
 * it. The alternative -- refusing an entity whose name happens to equal another
 * entity's derived index name -- would have made a declaration's legality depend
 * on which OTHER entities were declared beside it, and leaked this store's
 * naming scheme into the shared surface.
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
	assertStorableEntityNames([entity]);
	const table = quoted(entity.name);
	const idList = quotedList(entity.id);
	/** An index of this entity, in the store's own `_` namespace. See the module note. */
	const index = (suffix: string) => quoted(`_${entity.name}_${suffix}`);

	const columns = [
		`${ROWID} INTEGER PRIMARY KEY AUTOINCREMENT`,
		...entity.id.map((column) => `${quoted(column)} TEXT NOT NULL`),
		...Object.entries(entity.fields).map(([field, type]) => `${quoted(field)} ${sqlType(type)}`),
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
		`CREATE UNIQUE INDEX IF NOT EXISTS ${index('open')} ON ${table} (${idList}) WHERE ${UPPER} IS NULL`,
		// Time travel: the point as-of probe rides this B-tree, which is why it
		// stays effectively flat as history accumulates.
		`CREATE INDEX IF NOT EXISTS ${index('history')} ON ${table} (${idList}, ${LOWER})`,
		// Revert leg A: versions opened above the fork.
		`CREATE INDEX IF NOT EXISTS ${index('lower')} ON ${table} (${LOWER})`,
		// Revert leg B: versions closed above the fork.
		`CREATE INDEX IF NOT EXISTS ${index('upper')} ON ${table} (${UPPER})`,
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
