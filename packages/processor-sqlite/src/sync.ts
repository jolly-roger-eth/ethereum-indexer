import type {Abi, LastSync} from 'ethereum-indexer';
import type {RemoteSQL} from 'remote-sql';

/**
 * ## Where the sync cursor lives, and why it is here rather than in the store
 *
 * `LastSync` is a FIXED table, so it follows this repo's static-schema
 * convention (the one documented at the top of
 * `@ethereum-indexer/state-store-sqlite`'s `ddl.ts`): literal SQL written where
 * the code is, moving to a `.sql` file the day a codegen migration step exists.
 *
 * It lives in THIS package, not in the state store, and that is not a filing
 * preference. The store is asserted to import nothing but `remote-sql` and
 * `named-logs` (`state-store-sqlite/test/no-platform-leakage.test.ts`), because
 * a versioned-row store is a storage primitive that must not know what an
 * Ethereum indexer is. `LastSync` is a core `ethereum-indexer` type carrying
 * `unconfirmedBlocks` and a `ContextIdentifier`; putting its table in the store
 * would either drag that dependency in or force a duplicated shape that then
 * drifts. The cursor belongs to the thing that keeps a cursor, which is the
 * processor.
 *
 * ## One row, not one row per context
 *
 * The design (§1) keys the versioned state by `{source, config, processor}`, and
 * the obvious reading is that this table is keyed the same way. It is NOT, and
 * the reason is load-bearing rather than an economy.
 *
 * The core's discard path only fires when `load` RETURNS something whose context
 * does not match (`indexer.ts`: the mismatch branch is inside `if (loaded)`, and
 * it is the branch that calls `processor.clear()`). A table keyed by context
 * would answer "no row" after a processor upgrade, `load` would return
 * `undefined`, the core would start a fresh sync, and `clear()` would never be
 * called: the previous processor's entity rows would still be sitting in the
 * tables, and the new run would index on top of them.
 *
 * So the cursor is a single row and the context travels INSIDE it, where the
 * core already validates it. Keying the table would also imply a multi-tenancy
 * the rest of the schema does not have, since the entity tables carry no context
 * column and two contexts sharing a database would collide on entity rows long
 * before they collided on a cursor.
 */

/**
 * ## Why the cursor is not plain JSON
 *
 * `LastSync.unconfirmedBlocks` carries the actual `LogEvent`s of the reorg-eligible
 * window, and a decoded event's `args` hold **BigInt** values for every `uint256`
 * the ABI declares. `JSON.stringify` throws outright on a BigInt, so a plain
 * stringify works on every hand-built test cursor and fails on the first real
 * `Transfer` a chain produces.
 *
 * BigInts are therefore tagged on the way out and rebuilt on the way in. The tag
 * is an object with a single reserved key rather than the `"123n"` string
 * convention, because a suffix convention has to guess: it cannot tell a real
 * BigInt from a string a contract emitted that happens to end in `n`, and
 * guessing wrong silently rewrites event data.
 */
const BIGINT_TAG = '__bigint__';

function replacer(this: unknown, key: string, value: unknown): unknown {
	// `value` is already post-`toJSON`, so read the raw one to still see a BigInt
	const raw = (this as Record<string, unknown>)?.[key];
	if (typeof raw === 'bigint') return {[BIGINT_TAG]: raw.toString()};
	return value;
}

function reviver(_key: string, value: unknown): unknown {
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		const keys = Object.keys(value);
		if (keys.length === 1 && keys[0] === BIGINT_TAG) {
			const text = (value as Record<string, unknown>)[BIGINT_TAG];
			if (typeof text === 'string') return BigInt(text);
		}
	}
	return value;
}

/** Serialize a cursor, BigInts included. Exported so the round-trip can be tested directly. */
export function serializeLastSync<ABI extends Abi>(lastSync: LastSync<ABI>): string {
	return JSON.stringify(lastSync, replacer);
}

/** The inverse of `serializeLastSync`. */
export function deserializeLastSync<ABI extends Abi>(text: string): LastSync<ABI> {
	return JSON.parse(text, reviver) as LastSync<ABI>;
}

/** The fixed table holding the sync cursor. */
export const SYNC_TABLE = '_sync';

/** The single row's key. See the module note: there is deliberately only one. */
export const SYNC_ROW_ID = 'lastSync';

export const SYNC_SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS ${SYNC_TABLE} (
	id TEXT PRIMARY KEY,
	lastSync TEXT NOT NULL
)`,
];

/**
 * Read the stored cursor, or `undefined` if this database has never been synced.
 *
 * A row whose JSON does not parse is treated as "never synced" rather than
 * thrown: the recovery from a corrupt cursor is a fresh sync, and that is
 * exactly what `undefined` triggers.
 */
export async function readLastSync<ABI extends Abi>(db: RemoteSQL): Promise<LastSync<ABI> | undefined> {
	const result = await db
		.prepare(`SELECT lastSync FROM ${SYNC_TABLE} WHERE id = ?`)
		.bind(SYNC_ROW_ID)
		.all<{lastSync: string}>();
	const row = result.results[0];
	if (!row) return undefined;
	try {
		return deserializeLastSync<ABI>(row.lastSync);
	} catch {
		return undefined;
	}
}

/**
 * The statement that writes the cursor.
 *
 * Upserted, unlike a block row. That asymmetry is deliberate: applying the same
 * block twice is a caller bug and the store makes it a primary-key violation on
 * purpose, whereas a cursor exists precisely to be overwritten.
 */
export function writeLastSyncStatement<ABI extends Abi>(lastSync: LastSync<ABI>): {sql: string; args: unknown[]} {
	return {
		sql: `INSERT INTO ${SYNC_TABLE} (id, lastSync) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET lastSync = excluded.lastSync`,
		args: [SYNC_ROW_ID, serializeLastSync(lastSync)],
	};
}

/** Forget the cursor. Paired with wiping the state, never on its own. */
export function deleteLastSyncStatement(): {sql: string; args: unknown[]} {
	return {sql: `DELETE FROM ${SYNC_TABLE}`, args: []};
}
