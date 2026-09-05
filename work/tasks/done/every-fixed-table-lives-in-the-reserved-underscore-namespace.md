---
title: 'Every fixed table lives in the reserved `_` namespace, so an entity can never collide with one'
slug: every-fixed-table-lives-in-the-reserved-underscore-namespace
promotedFrom: observation:an-entity-named-like-a-fixed-table-collides-silently
blockedBy: []
covers: []
---

## What to build

Close a silent collision: a processor may declare an entity named exactly like one of the server's
FIXED tables, and nothing refuses it.

Entity tables are created as `CREATE TABLE IF NOT EXISTS "<entity.name>"`
(`packages/state-store-sqlite/src/ddl.ts`), and in every combined shape the store and the server
share ONE database handle (`buildProcessor`). So a processor declaring an entity called `Meta` or
`EmissionStream` issues that DDL against the SERVER's table: `IF NOT EXISTS` makes it succeed
silently, and the failure surfaces much later as a column error on a write, pointing nowhere near the
declaration that caused it.

### The mechanism already exists, and the server's tables simply sit outside it

This is the part that decides the shape. `@etherfold/state-store` already reserves a namespace and
already refuses entities inside it:

```ts
/** The store owns the `_` prefix: version columns, and its own fixed tables. */
function isReserved(name: string): boolean {
	return name.startsWith('_');
}
```

and the store's OWN fixed tables already live there: `BLOCKS_TABLE = '_blocks'` and
`CURSOR_TABLE = '_cursor'`. Declaring an entity called `_blocks` is refused today.

The server's `Meta` and `EmissionStream` are the same KIND of thing (infrastructure tables in a
shared database, not user entities) and are the only ones outside the namespace that protects them.

### The fix, DECIDED, and the alternative that was rejected

**Rename the server's fixed tables into the reserved namespace**: `Meta` -> `_meta` and
`EmissionStream` -> `_emissions`, matching `_blocks` and `_cursor`. The collision then becomes
impossible through the mechanism that already exists, with NO new API.

Rejected: parameterising the reserved set, so the composing host declares which names are taken. It
looked stronger and is not. It grows optional API on `@etherfold/state-store` for a guard that is off
by default (the browser uses the store with no server at all), and it relocates the discipline rather
than removing it: "remember to pass your fixed names in" is no better than "prefix a fixed table with
`_`", and it fails silently the same way when forgotten.

**Also update the docstring.** The `_` prefix is not "the store's"; it is "not a user entity". Say
that, since two packages now put tables there.

There is NO migration and NO compatibility shim. Nothing is deployed. The `schemaVersion` row lives
inside the table being renamed, so an old database reads as unapplied, which is the correct signal:
the tables really did change.

### The convention becomes a GUARANTEE, which is the second half of this task

A rename fixes today's two tables and leaves tomorrow's to memory. Close that cheaply and with no
runtime API: **a test asserts that every table and index `packages/server/src/schema/sql/db.sql`
creates begins with `_`.** A future fixed table that forgets the prefix then fails the gate instead
of shipping a silent collision.

That is the same move this repo already makes in `packages/core/test/oneReorgWriteSite.test.ts` and
the one-cursor-codec scan: a cheap source-level assertion standing in for a structural property.

## What this is NOT

- **NOT a change to what the tables CONTAIN.** Columns, indexes, keys and semantics are untouched:
  this is a rename plus a guard. The emission stream keeps every column and both its indexes, and
  still carries no generation or processor column.
- **NOT a new dependency.** `@etherfold/state-store` must not learn about `@etherfold/server`. If the
  fix needs that edge, it is the wrong fix.
- **NOT a widening of the entity legality rules** beyond the reserved-prefix check that already
  exists. The `IDENTIFIER` regex, the case-folding rule and the keyword posture stay as they are.
- **NOT a migration.** Do not write one, do not add a compatibility read of the old names.

## Acceptance criteria

- [ ] A processor declaring an entity named like a server fixed table is REFUSED, with the existing
      reserved-identifier error. Asserted for the renamed names, in the combined shape where one
      database handle is shared.
- [ ] `Meta` and `EmissionStream` are renamed into the reserved namespace, and no reference to the
      old names remains in shipped code or SQL.
- [ ] Every table and index created by `db.sql` begins with `_`, asserted by a test that scans the
      schema file, and that test has a guard so it cannot pass on an empty or unparsed scan.
- [ ] The reorg counters, the schema-version report and both feed views behave exactly as before the
      rename. The existing server, feed, canonical, compaction and equivalence suites stay green.
- [ ] The wrangler D1 migration path and the Node schema path still produce the same database, which
      the previous task already asserts: that assertion still holds.
- [ ] `isReserved`'s docstring says the prefix means "not a user entity" rather than "the store's",
      since two packages now place tables there.
- [ ] Ship a changeset for every published package whose surface changes.
- [ ] `pnpm build && pnpm typecheck && pnpm test` green.

## Blocked by

- None. It touches the schema file the emission-stream task created, so it is simplest AFTER
  `a-refetched-block-is-new-unless-the-window-already-holds-it` has landed, but there is no
  dependency between them.

## Prompt

> Close a silent collision in `etherfold`: a processor may declare an entity named exactly like one of
> the server's fixed tables (`Meta`, `EmissionStream`), and nothing refuses it. Entity DDL is
> `CREATE TABLE IF NOT EXISTS "<name>"` against the SAME database the server uses in every combined
> shape, so `IF NOT EXISTS` swallows it and the failure surfaces later as a column error on a write,
> far from the declaration that caused it.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does
> it still match the code, `work/tasks/done/` and the ADRs (0016 on the store's dependency posture,
> 0006 on the stored stream)? If a premise no longer holds, route to needs-attention.
>
> The mechanism to fix it ALREADY EXISTS and the server's tables simply sit outside it.
> `@etherfold/state-store` reserves the `_` prefix and refuses entities inside it, and the store's own
> fixed tables already live there as `_blocks` and `_cursor`. The server's two are the same kind of
> thing and the only ones unprotected.
>
> So the fix is DECIDED: rename `Meta` -> `_meta` and `EmissionStream` -> `_emissions`. No new API, no
> migration, no compatibility shim, nothing deployed. The `schemaVersion` row lives in the table being
> renamed, so an old database reads as unapplied, which is the correct signal.
>
> Do NOT parameterise the reserved set so a host passes its fixed names in. It was considered and
> rejected: it grows optional API on the store for a guard that is off by default (the browser uses
> the store with no server), and it relocates the discipline instead of removing it.
>
> Then make the convention a GUARANTEE, which is the second half of the task: a test that scans
> `packages/server/src/schema/sql/db.sql` and asserts every table and index it creates begins with
> `_`, with a guard so it cannot pass on an empty scan. That is the same move as
> `oneReorgWriteSite.test.ts`: a source-level assertion standing in for a structural property, so a
> future fixed table that forgets the prefix fails the gate rather than shipping a collision.
>
> Change nothing about what the tables CONTAIN, add no dependency from the store to the server, and do
> not widen the entity legality rules beyond the reserved-prefix check that already exists.
>
> Done means: an entity named like a fixed table is refused in the combined shape, the old names
> appear nowhere in shipped code or SQL, every `db.sql` table and index starts with `_` and a test
> says so, and every existing suite is green.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT, in
> particular the exact new names and how the schema-file scan parses the DDL.

## Decisions

- **The new names are `_meta` and `_emissions`, exactly as the task decided; the INDEX names are mine.** `_emissions_canonical` and `_emissions_by_address_topic`. The task named the tables but not the two indexes, and SQLite puts tables and indexes in ONE namespace, so an unprefixed index is the same collision. I followed the store's existing convention (`_blocks_timestamp`, and `_<entity>_<suffix>` for derived entity indexes) rather than transliterating the camel-case names, so all fixed names in the database read alike. Alternative considered: `_emissionsCanonical`, keeping the old spelling with a prefix; rejected because it would be the only camel-case name in the reserved namespace. Checked for overlap: an entity named `emissions` derives `_emissions_open|history|lower|upper`, none of which collide with these two. Touches: `packages/server/README.md` and the `feed/canonical.ts` comment, which name the partial index.
- **The schema-file scan parses the DDL with a regex over the comment-stripped file, and proves it parsed everything.** It reads `packages/server/src/schema/sql/db.sql` from disk (not the generated `db.sql.ts`, not a live database), strips `--` comments the way `schemaStatements` does, then matches `CREATE [UNIQUE] (TABLE|INDEX) [IF NOT EXISTS] [quote]<name>`. Comments must go first because one of them says "CREATE TABLE" while describing what is deliberately NOT in the file. The honest weakness of a regex scan is that it passes when it matches nothing, so the guard asserts the parsed count EQUALS the number of `CREATE` keywords in the stripped DDL: a future statement spelled in a way the matcher cannot read fails the test instead of silently escaping the rule. Alternative considered: scanning `schemaStatements` or `sqlite_master` after `applySchema`; rejected because the file is what BOTH application paths consume (wrangler runs the file and calls nothing of ours), and the criterion asks for a file scan. Touches: nothing outside the server package.
- **`SCHEMA_VERSION` stays at 2 rather than bumping to 3.** The version row lives in the table that was renamed, so a database migrated by an older build has no `_meta` at all and `readSchemaState` reports `applied: false` — a stronger and more accurate signal than a number mismatch, and the one the task calls correct. No database can hold a `_meta` row this build did not write, so "2 in `_meta`" is unambiguous. Alternative considered: bumping to 3 on a literal reading of the constant's docstring ("bumped whenever db.sql changes in a way an existing database has to be told about"); rejected because no existing database can be told anything through a row it cannot find, and a bump would imply a version-2 `_meta` exists somewhere. I recorded the reasoning at the constant. Touches: `packages/server/test/server.test.ts`, which asserts the SQL row and the constant agree (still does), and `/status`, which reports both.
- **The reserved-identifier ERROR MESSAGE changed with the docstring.** It said `Names starting with "_" belong to the store.`; it now says `... are not user entities.` The criterion only asked for the docstring, but leaving the message asserting the thing the docstring now corrects would re-mean the same term one line apart. No test or doc asserts the old string (checked). It is user-visible text on a refusal, hence recorded rather than silent. Touches: `@etherfold/state-store` consumers who match on the message; none in this repo.
