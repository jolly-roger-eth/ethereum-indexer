/**
 * ## Where the sync cursor went
 *
 * It used to be HERE: a `_sync` table in this package, written with a `SELECT`
 * and an `INSERT ... ON CONFLICT` through the `RemoteSQL` handle, on the
 * argument that where a processor keeps `LastSync` is the processor's business
 * (ADR-0016) and that a storage primitive must not know what an Ethereum indexer
 * is (ADR-0018).
 *
 * That argument was right about the MEANING and wrong about the STORAGE, and two
 * things said so. A browser deployment on IndexedDB has no SQL to write a cursor
 * into, so a cursor that could only be a table stopped "one processor, several
 * backends" at the first deployment that was not SQLite. And a cursor outside the
 * store is a second round trip AFTER the block it describes: a crash in that
 * window left state ahead of the cursor, the restart replayed a block the store
 * already held, `applyBlock` refused it as the caller bug it normally is, and the
 * indexer wedged until a human intervened.
 *
 * So the cursor moved BEHIND the storage seam, as an opaque string under one key
 * (`StateStore.readCursor` / `writeCursor` / `clearCursor`, and `applyBlock`'s
 * third argument), because only the store holds the transaction the block write
 * happens in. ADR-0016 is intact: the store persists a string and still has no
 * idea what a `LastSync` is. On this backend it is the `_cursor` table, created
 * by `@etherfold/state-store-sqlite` alongside `_blocks`.
 *
 * What is left in this module is the CODEC, which was always backend-neutral and
 * now lives with the thing that understands the string
 * (`@etherfold/processor-entities`). It is re-exported here because this
 * package's public surface has carried it since the cursor existed.
 */
export {
	deserializeLastSync,
	parseStoredCursor,
	serializeLastSync,
	syncedThrough,
	SYNC_CURSOR_KEY,
} from '@etherfold/processor-entities';
