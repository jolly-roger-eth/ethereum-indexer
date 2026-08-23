import {
	idValues,
	prefixValues,
	type EntityId,
	type EntityIdPrefix,
	type NormalizedEntity,
} from '@etherfold/state-store';

/**
 * The storage layout, which is three object stores and three indexes.
 *
 * ```
 * current   [entity, ...id]         -> {lower, values}        the tip read and the tip listing
 * versions  [entity, ...id, lower]  -> {lower, upper, values} the history, for as-of and for revert
 * blocks    number                  -> {number, hash, timestamp}
 * ```
 *
 * **The entity name is part of the KEY rather than the name of a store**, which
 * is the one structural difference from the SQL backend and it is deliberate.
 * Creating an object store in IndexedDB requires a version change and therefore
 * an upgrade transaction that no other tab may hold a connection through, so a
 * store per entity would turn "the processor declares one more entity" into a
 * schema migration that a second open tab BLOCKS. With the entity in the key the
 * schema is fixed at version 1 forever, and every access path a table would have
 * given is still a key range, because a key range on `[entity, ...]` is exactly
 * "that entity's rows".
 *
 * `values` is the COMPLETE row (id columns and every declared field, unlisted
 * ones NULL), so a version means the same thing here as everywhere else. It is
 * duplicated between `current` and `versions` for the live version, which is the
 * shape the measurements in `work/notes/findings/sqlite-in-the-browser.md` were
 * taken on: it buys a tip read that is ONE `get` (305 us on Chromium, against
 * 1,246 for the wasm-SQLite candidate) and a tip listing that never reads a
 * superseded version, and it costs one extra copy of the live set.
 */
export const SCHEMA_VERSION = 1;
export const CURRENT = 'current';
export const VERSIONS = 'versions';
export const BLOCKS = 'blocks';

/** Unique: a hash identifies one block, and a second claim on it is a caller bug. */
export const HASH_INDEX = 'hash';
/**
 * Revert leg A: the versions a fork opened. Range scan, never a scan of the store.
 */
export const LOWER_INDEX = 'lower';
/**
 * Revert leg B and the prune: the versions that were CLOSED, ordered by when.
 *
 * A live version has `upper: null`, which is not a valid IndexedDB key, so it is
 * not in this index at all. That is not a trick, it is the property the prune
 * needs most: the LIVE version of an entity is the current state however old it
 * is, and a prune written as "drop what is older than the floor" destroys it. It
 * cannot be reached from here.
 */
export const UPPER_INDEX = 'upper';

/** One version: a complete row plus its half-open block-validity range. */
export type VersionRecord = {
	lower: number;
	/** Exclusive; `null` means live, and keeps the record out of `UPPER_INDEX`. */
	upper: number | null;
	values: Record<string, unknown>;
};

/** The live version of one business key, so a tip read is one `get`. */
export type CurrentRecord = {lower: number; values: Record<string, unknown>};

/** The block record: what `_blocks` is in the SQL backend. */
export type BlockRecord = {number: number; hash: string; timestamp: number};

/** The key of one business key's row: the entity name, then the id, as strings. */
export function rowKey(entity: NormalizedEntity, id: EntityId): IDBValidKey[] {
	return [entity.name, ...idValues(entity, id)];
}

/** The key of one VERSION of that row: the row's key with the block it opened at. */
export function versionKey(row: readonly IDBValidKey[], lower: number): IDBValidKey[] {
	return [...row, lower];
}

/** The row a version key belongs to: everything but the trailing block number. */
export function rowOfVersionKey(key: readonly IDBValidKey[]): IDBValidKey[] {
	return key.slice(0, -1);
}

/**
 * The range of every key that STARTS WITH `key`, which is the whole trick.
 *
 * IndexedDB orders an array key element by element and sorts an array AFTER
 * every number, string and binary key, so `[]` is greater than any element that
 * could follow the prefix and no real key can equal the upper bound. That makes
 * `bound([...prefix], [...prefix, []])` exactly "the prefix and its
 * descendants", and it is why the listing at the seam is a prefix of the
 * declared id and nothing else: this is one indexed range scan, on a store with
 * no query planner in it (ADR-0021).
 */
export function startingWith(key: readonly IDBValidKey[]): IDBKeyRange {
	return IDBKeyRange.bound([...key], [...key, []]);
}

/**
 * The range a listing scans: the entity's rows whose id starts with the prefix.
 *
 * The prefix is validated by the seam (`prefixValues`), so a prefix that is not
 * a LEADING run of the declared id columns is refused here in the same words as
 * on every other backend rather than quietly scanning something else.
 */
export function listingRange(entity: NormalizedEntity, prefix: EntityIdPrefix): IDBKeyRange {
	return startingWith([entity.name, ...prefixValues(entity, prefix)]);
}

/**
 * The versions of one row that opened at or before `at`, so an as-of read is a
 * cursor walked BACKWARDS: the first hit is the version live then, if any.
 */
export function asOfRange(row: readonly IDBValidKey[], at: number): IDBKeyRange {
	return IDBKeyRange.bound([...row], [...row, at]);
}

/** Everything strictly above the fork point: the range both revert legs walk. */
export function above(blockNumber: number): IDBKeyRange {
	return IDBKeyRange.lowerBound(blockNumber, true);
}
