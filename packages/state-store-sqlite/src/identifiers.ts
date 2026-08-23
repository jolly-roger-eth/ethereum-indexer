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
