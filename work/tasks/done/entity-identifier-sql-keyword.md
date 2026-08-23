---
title: An entity column named `index` passes validation and then breaks migrate() on SQLite only
slug: entity-identifier-sql-keyword
blockedBy: []
covers: []
---

## What to build

Close a defect where one entity declaration is legal on one backend and fatal on another, and fails at MIGRATION rather than at declaration.

Declaring an entity whose id column or field is named `index`:

```ts
{name: 'placementPlayer', id: ['epoch', 'position', 'index'], fields: {color: 'integer', address: 'text'}}
```

passes `@etherfold/state-store-sqlite`'s validation (it matches the identifier regex `/^[A-Za-z][A-Za-z0-9_]*$/` and does not start with the reserved `_`), then fails at `store.migrate()` with `SQLITE_ERROR: near "index": syntax error`, and is accepted without complaint by a non-SQL backend (both the in-memory and IndexedDB prototypes stored and read it fine). Reproduced against libSQL in node on 2026-08-22 while porting a real processor.

**Mechanism.** `packages/state-store-sqlite/src/ddl.ts` interpolates table and column names into DDL text, because SQL cannot bind an identifier as a parameter, and `internal/identifiers.ts` guards that interpolation with a SHAPE check only. A SQL KEYWORD has a valid identifier shape, so it passes the guard and produces `..., index INTEGER, ...`, which SQLite rejects. `index`, `order`, `group`, `select`, `table`, `where`, `default`, `references` and `primary` are all in the same position.

**Why it is worth a task rather than a rename.** The declaration is the SHARED surface: one processor writes one set of entity declarations and several backends store them. A name that is legal on the light backend and fatal on the SQL backend makes a processor silently non-portable, and it fails at deploy time on one platform only, rather than where it was written.

**Fix shape.** Either is defensible and they are not exclusive:

- **Quote identifiers** in `ddl.ts` and `statements.ts` (`"index"` in standard SQL, which SQLite accepts), so any valid identifier shape works; or
- **Reject reserved words** in `internal/identifiers.ts`, so the failure moves to declaration time with a message naming the entity and the column.

The second is the smaller change and matches the module's stated stance ("names are validated once, at declaration time, rather than trusted"). The first is more permissive and would also cover a name that becomes a keyword in a future SQLite version. Quoting alone still leaves the `_`-prefix rule doing its job. Pick deliberately, and note that "reject" is a source-compatibility break for anyone who already has such a column, while "quote" is not.

Whichever is chosen, the outcome must be that the SAME declaration behaves the same way on every backend: either it works everywhere, or it is refused everywhere, at declaration time.

## Acceptance criteria

- [ ] An entity declaring a column named `index` either migrates and round-trips correctly, or is refused at DECLARATION time with a message naming the entity and the column. Not accepted-then-fatal-at-migrate.
- [ ] The behaviour is the SAME across backends: a declaration refused by one is refused by all, and one accepted by one is accepted by all. This is the actual defect and it needs its own test.
- [ ] A test covers a spread of SQL keywords in both a key column and a data field, not just `index`.
- [ ] The `_` prefix rule still rejects what it rejected before.
- [ ] If the chosen fix is a rejection, the error message says what to do (rename the column) and the change is noted as a compatibility break in the changeset.
- [ ] Tests in `packages/state-store-sqlite/test/` (mirroring `schema.test.ts`), vitest, plus a changeset.

## Blocked by

- None, can start immediately.

## Prompt

> Fix a defect in `@etherfold/state-store-sqlite` in the `etherfold` monorepo (the repository directory is still named `ethereum-indexer`): an entity column named after a SQL keyword passes identifier validation and then makes `migrate()` throw, while non-SQL backends accept it silently.
>
> FIRST, check this task against current reality: read `packages/state-store-sqlite/src/internal/identifiers.ts` (the shape-only guard), `src/ddl.ts` and `src/statements.ts` (where identifiers are interpolated into SQL text, because SQL cannot bind an identifier as a parameter), and `test/schema.test.ts` for the existing validation tests and their style. If the identifiers module has already been changed, confirm the defect still reproduces before fixing it.
>
> Reproduce first: declare an entity with a column named `index`, call `migrate()`, and observe `SQLITE_ERROR: near "index": syntax error` after validation passed. `index`, `order`, `group`, `select`, `table`, `where`, `default`, `references` and `primary` are all in the same position.
>
> Two defensible fixes, and they are not exclusive. QUOTE the identifiers in the DDL and statement builders (`"index"`, which SQLite accepts), so any valid identifier shape works; or REJECT reserved words in the validator, so the failure moves to declaration time with a message naming the entity and the column. The second is smaller and matches the module's stated stance that names are validated once at declaration time rather than trusted; the first is more permissive and survives a future SQLite adding keywords. Rejecting is a source-compatibility break for an existing declaration; quoting is not.
>
> The property that actually matters is CROSS-BACKEND AGREEMENT, so make it a test: the same declaration must not be legal on one backend and fatal on another. That is the reason this is a defect rather than a naming preference.
>
> Context, not required reading but it explains the urgency: `work/notes/findings/sqlite-in-the-browser.md` surfaced this while porting a real processor, and `work/specs/proposed/one-processor-everywhere.md` makes the entity declaration a shared surface across several backends, which is what turns a SQLite quirk into silent non-portability.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your final report, in particular which fix you chose and whether it breaks an existing declaration.

## Decisions

**Chose QUOTE over REJECT, and did not do both.** The task offered either. I quoted, in `@etherfold/state-store-sqlite` only. Why: the property that makes this a defect is that a declaration's legality must be a fact about the *declaration*, not about the deployment, and quoting is the option that makes this backend accept *exactly* what the shared seam accepts. Rejecting would have pushed one engine's reserved-word list into `@etherfold/state-store`, which every backend shares including the ones with no SQL in them, and would re-open the same hole the day SQLite adds a keyword or a second SQL backend arrives with a different list. Doing both would combine the compatibility break of rejecting with none of its benefit. **This is NOT a source-compatibility break**: every declaration legal before is still legal, and the ones that were fatal on SQLite now work. The rejected alternative *would* have been a break for anyone already declaring such a column. Touches: `@etherfold/state-store`'s validator (deliberately left shape-only, with the rationale now written there) and any future SQL backend, which inherits the obligation to quote rather than a list to copy.

**Quoted only DECLARATION-derived identifiers, not the store's own.** `_lower`, `_upper`, `_rowid`, `_blocks` and its three columns stay bare. Alternative considered: quote every identifier uniformly, which is a simpler rule to state but churns the fixed-schema DDL and every existing test that pins it, for names this package chose itself and knows are safe. The rule as written is legible at a glance ("quoted = came from outside"), and it is documented in `src/identifiers.ts`.

**Put the cross-backend fixture in `CONFORMANCE_ENTITIES` rather than in a case-local declaration set.** That makes every existing case migrate it, every revert sweep it and every prune consider it, so the keyword identifiers reach every statement a backend emits rather than only its DDL. Cost: it is a real (minor) change to the shared conformance surface, so a backend outside this repo that upgrades and does not quote will see its whole run go red rather than one case. That is deliberate and is stated in the changeset; it is also exactly what happened here, which is how I know the case has teeth.

**Exported `quoted` / `quotedList` from `@etherfold/state-store-sqlite`.** New public API surface (additive). The reason is the caller-supplied-SQL tier: `queryCurrent({where: 'default > ?'})` is the caller's SQL to write and therefore the caller's to quote, and without an exported helper every consumer with a keyword column hand-rolls one. Alternative considered: keep it internal (matching the `internal/` placement the original task assumed). I rejected that because the package exports every other module in `src/` and because the query tier genuinely needs it. Touches: anyone writing `QueryOptions.where` / `orderBy`.

**Did not add an ADR.** The choice is easy to reverse (rejecting keywords could be layered on later without undoing the quoting) and the trade-off is fully written at the choice site plus the changeset, so it does not clear the ADR gate.
