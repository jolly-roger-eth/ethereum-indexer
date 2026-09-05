---
date: 2026-09-05
---

# An entity declaration may name a FIXED table, and nothing refuses it

Noticed while adding the `EmissionStream` table to `packages/server/src/schema/sql/db.sql`.

Entity tables are named exactly `entity.name` (`packages/state-store-sqlite/src/ddl.ts`, `quoted(entity.name)`), and declaration legality reserves only the leading `_` namespace (`packages/state-store/src/entities.ts`) and SQLite's own `sqlite_` prefix. The server's FIXED tables (`Meta`, and now `EmissionStream`) are in the SAME database as the entity tables in every combined shape (`buildProcessor` hands one handle to both the store and the server), so a processor declaring an entity called `Meta` or `EmissionStream` gets `CREATE TABLE IF NOT EXISTS "Meta"` against the server's table: the DDL SUCCEEDS silently because of `IF NOT EXISTS`, and the failure surfaces later as a column error on a write.

Pre-existing with `Meta`; this task widens it by one name. Not fixed here (it is a cross-package decision about where the fixed names are declared and which layer refuses them, and it is outside this task's fence).
