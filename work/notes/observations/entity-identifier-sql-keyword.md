---
title: 'An entity column named `index` passes validation and then breaks migrate() on SQLite only'
slug: entity-identifier-sql-keyword
---

Spotted while porting the stratagems processor to `MutationContext` during `spike-sqlite-in-the-browser`.

## What happens

Declaring an entity whose id column (or field) is named `index`:

```ts
{name: 'placementPlayer', id: ['epoch', 'position', 'index'], fields: {color: 'integer', address: 'text'}}
```

- passes `@etherfold/state-store-sqlite`'s `normalizeEntity` validation: it matches `IDENTIFIER` (`/^[A-Za-z][A-Za-z0-9_]*$/`) and does not start with the reserved `_`;
- then fails at `store.migrate()` with `SQLITE_ERROR: near "index": syntax error`, from `packages/state-store-sqlite/src/store.ts` inside the DDL batch;
- and is accepted without complaint by a non-SQL backend (both the in-memory and the IndexedDB prototypes in the spike stored and read it fine).

Reproduced against libSQL in node (`docs/spikes/sqlite-in-the-browser/run/verify-store.ts` at the time it was first run) on 2026-08-22.

## Mechanism

`packages/state-store-sqlite/src/ddl.ts` interpolates table and column names into DDL text, because SQL cannot bind an identifier as a parameter, and `internal/identifiers.ts` guards that interpolation with a SHAPE check only. A SQL KEYWORD has a valid identifier shape, so it passes the guard and produces `..., index INTEGER, ...`, which SQLite rejects. `index`, `order`, `group`, `select`, `table`, `where`, `default`, `references` and `primary` are all in the same position.

## Why it matters more than a typo

The declaration is the SHARED surface: `one-processor-everywhere` has one processor writing one set of entity declarations and several backends storing them. A name that is legal on the light backend and fatal on the SQL backend makes a processor silently non-portable, and it fails at MIGRATION, meaning at deploy time on one platform only, rather than where it was written.

## Fix shape (not applied; that spike changed no production code beyond capture/replay)

Either is defensible and they are not exclusive:

- **Quote identifiers** in `ddl.ts` and `statements.ts` (`"index"` in standard SQL, which SQLite accepts), so any valid identifier shape works; or
- **Reject reserved words** in `internal/identifiers.ts`, so the failure moves to declaration time, with a message naming the entity and the column.

The second is the smaller change and matches the module's stated stance ("names are validated once, at declaration time, rather than trusted"). The first is the more permissive one and would also cover a name that is a keyword in some future SQLite version. Quoting alone still leaves the `_`-prefix rule doing its job.

The spike worked around it by renaming the column to `playerIndex`, and recorded the trap in `docs/spikes/sqlite-in-the-browser/src/port/entities.ts` next to the declaration.
