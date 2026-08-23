---
title: A declaration is legal or refused everywhere, and the rule is the seam's
slug: declaration-legality-is-one-rule-everywhere
blockedBy: []
covers: []
---

## What to build

Close the rest of the defect class `entity-identifier-sql-keyword` opened: a declaration whose legality depends on which backend stores it.

That task fixed the SQL-keyword half by quoting identifiers in `@etherfold/state-store-sqlite`, and its reasoning is the constraint for this one: SQLite's reserved-word list does NOT belong in `@etherfold/state-store`, because the seam is shared by backends with no SQL in them. Read `docs/adr/0018`, `packages/state-store-sqlite/src/identifiers.ts` and the `## Decisions` block of `work/tasks/done/entity-identifier-sql-keyword.md` before touching the validator, so you extend that decision rather than reverse it.

**The known open instance** is `work/notes/observations/entity-names-differing-only-in-case-collide-on-sqlite.md`: `{name: 'token'}` and `{name: 'Token'}` are accepted (`normalizeEntities` de-duplicates by exact string), but SQLite identifiers are case-INSENSITIVE, so `CREATE TABLE IF NOT EXISTS "Token"` matches the existing `token` and is silently skipped. One table exists, and `getCurrent('Token', ...)` returns `token`'s row. The memory, patch and IndexedDB backends keep them as two entities. **Quoting does not fix this**: a quoted identifier is still case-insensitive in SQLite.

A case-insensitive UNIQUENESS rule is a portability rule rather than one engine's vocabulary, so unlike a keyword list it does belong at the seam. State that distinction where a reader will meet it, because the two decisions look contradictory otherwise.

**Do not stop at the one instance.** The point of this task is the CLASS. Audit what a declaration may contain and decide, deliberately, which of these are legal everywhere, refused everywhere, or genuinely backend-specific — then pin the answer:

- names differing only in case (the known instance)
- identifier LENGTH (SQLite tolerates very long names; IndexedDB key sizes and readability do not make that free)
- non-ASCII / Unicode identifiers, including names equal only after NFC/NFD normalisation, which is the same collision shape as case
- names that are legal shapes but collide with the store's own reserved space beyond the existing `_` prefix rule
- the id-column and field spellings, not only entity names: every rule here must apply at all three levels, since `entity-identifier-sql-keyword` was originally reported on an id COLUMN

For each: either it is legal on every backend, or it is refused at DECLARATION time with a message naming the entity, the offending name and what to do. What must not survive is a third outcome where one backend accepts and another diverges or dies.

Where a rule cannot be seam-level (a genuinely engine-specific limit), the backend enforces it at declaration time too, not at `migrate()`. Failing where the declaration was written is the property this class is about.

## Acceptance criteria

- [ ] Two entities whose names differ only in case are refused at declaration time, on EVERY backend, naming both names. A test pins that the memory, patch, SQLite and IndexedDB backends agree.
- [ ] The same rule applies to id columns and to fields, not only to entity names.
- [ ] The audit above is carried out and its outcome recorded: for each candidate, legal-everywhere / refused-everywhere / backend-specific-but-refused-at-declaration, with the reason. An item deliberately left alone says so and why.
- [ ] Every rule added is exercised by the shared conformance suite, so a new backend inherits the obligation rather than rediscovering it. `portable-declarations.ts` is where the existing cross-backend cases live.
- [ ] `entity-identifier-sql-keyword`'s quoting still works and its tests still pass unchanged in meaning: this task extends that fix, it does not replace it.
- [ ] The `_` prefix rule still rejects what it rejected before.
- [ ] The seam does NOT gain a SQL reserved-word list. If you believe it should, route to needs-attention instead: that reverses an accepted decision and is not this task's call.
- [ ] Tests in the affected packages' `test/`, vitest, plus a changeset. Source-compatibility breaks are fine here and need no special handling beyond being named in the changeset.

## Prompt

> Close the rest of the "one declaration, different meanings on different backends" defect class in the `etherfold` monorepo (the repository directory is still named `ethereum-indexer`).
>
> FIRST read `work/tasks/done/entity-identifier-sql-keyword.md` (its `## Decisions` block especially), `packages/state-store-sqlite/src/identifiers.ts`, `packages/state-store/src/declarations.ts` and `packages/state-store-conformance/src/cases/portable-declarations.ts`. That task fixed the SQL-keyword half by QUOTING in the SQLite package, and deliberately did NOT put a reserved-word list at the seam because the seam is shared by backends with no SQL in them. Extend that reasoning; do not reverse it.
>
> The known open instance is `work/notes/observations/entity-names-differing-only-in-case-collide-on-sqlite.md`. Quoting does not fix it: SQLite identifiers are case-insensitive even when quoted, so `token` and `Token` become one table while every other backend keeps two entities. A case-insensitive uniqueness rule is a PORTABILITY rule rather than one engine's vocabulary, which is why it belongs at the seam where a keyword list did not. Say that distinction out loud in the code, because the two decisions look contradictory side by side.
>
> Do not stop at that instance. Audit the class: identifier length, non-ASCII and Unicode-normalisation collisions (the same shape as case), collisions with the store's reserved space, and all of it at entity, id-column and field level. Decide each deliberately and record the outcome, including the ones you leave alone.
>
> The property to preserve is that a declaration is legal everywhere or refused everywhere, at DECLARATION time, never accepted-then-divergent and never fatal at `migrate()`. Put every new rule in the conformance suite so a future backend inherits it.
>
> Source-compatibility is NOT a constraint here; breaking an existing declaration is acceptable if the rule is right. Name it in the changeset.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your final report, in particular the audit outcome per candidate and anything you deliberately left legal.
