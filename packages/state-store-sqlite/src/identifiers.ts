/**
 * ## Why every identifier from a declaration is QUOTED
 *
 * SQL cannot bind an identifier as a parameter. A table or a column name reaches
 * the engine as TEXT, which is why the seam validates the SHAPE of every name a
 * declaration carries (`normalizeEntity`, `@etherfold/state-store`) instead of
 * letting this package interpolate whatever it is handed.
 *
 * A shape check is not enough on its own, because a SQL KEYWORD has a perfectly
 * ordinary identifier shape. `index`, `order`, `group`, `select`, `table`,
 * `where`, `default`, `references` and `primary` all match
 * `/^[A-Za-z][A-Za-z0-9_]*$/`, so an entity declaring an id column named `index`
 * passed validation and then produced `..., index TEXT NOT NULL, ...`, which
 * SQLite rejects: `SQLITE_ERROR: near "index": syntax error`. The light and
 * IndexedDB backends stored the same declaration without complaint, so the
 * processor was silently non-portable and failed at deploy time on one platform
 * only (`work/notes/findings/sqlite-in-the-browser.md`).
 *
 * Quoting is the fix rather than a keyword blocklist, because the property that
 * matters is that a declaration is valid or invalid as a fact about the
 * DECLARATION rather than about the backend. Rejecting keywords would push one
 * engine's reserved-word list into the seam every backend shares, break
 * declarations that are legal today, and re-open the same hole the day SQLite
 * adds a keyword or a second SQL backend brings its own list. Quoting makes this
 * backend accept exactly what the seam accepts, which is the agreement the
 * conformance suite now asserts.
 *
 * ## The rule, and its edge
 *
 * QUOTE what came from a DECLARATION: the entity name, its id columns, its
 * fields, and the index names derived from the entity name. Do NOT quote the
 * store's OWN identifiers (`_lower`, `_upper`, `_rowid`, `_blocks` and its three
 * columns): they are chosen here, they are fixed, and leaving them bare keeps
 * "quoted" readable as "this name came from outside".
 *
 * Quoting is not a licence to interpolate anything, and it is not the security
 * boundary: the shape check still runs first and still rejects a `"` outright,
 * so the doubling below is the correct escaping for a name that can no longer
 * occur rather than the thing standing between a declaration and injection.
 */

/** One identifier as SQL text: double-quoted, with any embedded quote doubled. */
export function quoted(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

/** A comma-separated identifier list, e.g. the columns of an index. */
export function quotedList(names: readonly string[]): string {
	return names.map(quoted).join(', ');
}

/**
 * ## The one name quoting cannot rescue
 *
 * SQLite reserves every SCHEMA-OBJECT name beginning with `sqlite_` (matched
 * case-insensitively) for its own use, and refuses to create one however it is
 * spelled: `CREATE TABLE "sqlite_thing" (...)` is
 * `SQLITE_ERROR: object name reserved for internal use`. Unlike a keyword this
 * survives quoting, so there is nothing this package can do at DDL time.
 *
 * That makes it the one shape in this class that is genuinely THIS engine's
 * limit rather than the declaration's: a `sqlite_`-prefixed entity name is
 * stored happily by the memory, patch and IndexedDB backends. It does not become
 * a seam rule for that reason -- the seam would then carry one engine's
 * namespace, which is the thing `entity-identifier-sql-keyword` decided against
 * -- but it does move to DECLARATION time, here, so it fails where the store was
 * constructed instead of at `migrate()` on a deployed server. That is the
 * property the conformance suite asserts of every backend: refused when the
 * declaration is made, or storable, and never a third thing.
 *
 * It applies to entity names ONLY. A `sqlite_`-prefixed COLUMN is perfectly
 * legal in SQLite, so refusing one would be this backend narrowing the seam for
 * no engine reason at all -- the opposite failure, and just as visible to a
 * processor author.
 */
export const SQLITE_INTERNAL_PREFIX = 'sqlite_';

/**
 * Refuse, at construction, any entity this engine could not create a table for.
 *
 * Called by `VersionedStateStore`'s constructor and by `ddlForEntity`, which
 * between them is every route from a declaration to DDL.
 */
export function assertStorableEntityNames(entities: Iterable<{readonly name: string}>): void {
	for (const entity of entities) {
		if (entity.name.toLowerCase().startsWith(SQLITE_INTERNAL_PREFIX)) {
			throw new Error(
				`entity ${JSON.stringify(entity.name)} cannot be stored by @etherfold/state-store-sqlite: ` +
					`SQLite reserves object names beginning with "${SQLITE_INTERNAL_PREFIX}" for its own use, ` +
					`however they are quoted. Rename the entity. (A "${SQLITE_INTERNAL_PREFIX}" column name is fine; ` +
					`only the entity name becomes a table name.)`,
			);
		}
	}
}
