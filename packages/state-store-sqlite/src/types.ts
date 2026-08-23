/**
 * The vocabulary this store speaks is NOT its own.
 *
 * `{name, id, fields}`, a business key, a mutation and a block pointer are the
 * seam every backend shares, so they are defined once in `@etherfold/state-store`
 * and re-exported here. A processor written against the seam therefore hands
 * this store the very same declarations it would hand an in-memory or
 * object-store backend, with no translation layer and no second definition to
 * drift.
 *
 * What is genuinely this package's own is below: SQL text.
 */
export type {
	BlockPointer,
	BlockUpdate,
	EntityDeclaration,
	EntityId,
	FieldType,
	Mutation,
	NormalizedEntity,
} from '@etherfold/state-store';

import type {FieldType} from '@etherfold/state-store';

/**
 * The storage classes an entity field may declare.
 *
 * @deprecated Use `FieldType`. The set is the seam's, not SQLite's: it is the
 * intersection of what every backend can hold, and it happens to coincide with
 * SQLite's storage classes.
 */
export type ColumnType = FieldType;

/**
 * A statement before it is prepared.
 *
 * Statements are built as plain data so they can be counted, sized and grouped
 * into batches before any of them touches the database, and so the ordering
 * inside a batch can be asserted by a test.
 */
export type Statement = {sql: string; args: unknown[]};
