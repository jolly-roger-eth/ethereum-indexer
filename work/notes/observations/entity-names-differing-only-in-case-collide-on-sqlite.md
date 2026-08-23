---
title: 'Two entity names differing only in case are one table on SQLite and two entities everywhere else'
slug: entity-names-differing-only-in-case-collide-on-sqlite
observed: 2026-08-23
source: 'task:entity-identifier-sql-keyword, while fixing the SQL-keyword half of the same hole'
---

Declaring `{name: 'token', ...}` and `{name: 'Token', ...}` to `@etherfold/state-store-sqlite` is accepted (`normalizeEntities` de-duplicates by exact string), but SQLite identifiers are case-INSENSITIVE, so `CREATE TABLE IF NOT EXISTS "Token"` matches the existing `token` and is silently skipped: `sqlite_master` holds one table, and `getCurrent('Token', ...)` returns the `token` row with `token`'s columns. The light, memory and IndexedDB backends keep them as two separate entities. Same shape of defect as `entity-identifier-sql-keyword` (a declaration meaning different things on different backends), different cause, and NOT fixed by quoting: quoted identifiers are still case-insensitive in SQLite.

Not touched here (out of scope: this task closed the SQL-keyword half). Worth a task if it is real for a processor author; the fix is presumably a case-insensitive duplicate check at the seam, which would be a source-compatibility break for anyone already declaring both.
