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

## Decisions

**Audit outcome, per candidate.**

- *Names differing only in case* (the known instance) → **refused everywhere, at the seam.** No spelling of the DDL makes SQLite keep `token` and `Token` apart, so the answer cannot be a backend's. Touches: any existing declaration with two such names (a source break, named in the changeset).
- *Identifier length* → **legal everywhere, left alone.** Measured, not assumed: libSQL creates a 2,000-character table name plus its four derived indexes and round-trips a row through it; the other three backends hold names as ordinary JS strings, and IndexedDB puts the entity name in an array key with no limit. Inventing a seam limit would refuse declarations no engine objects to. Pinned by two probes (200-char entity name; 200-char id column and field) so a future backend that *does* impose one is caught. Alternative considered and rejected: a conservative 63-char limit borrowed from Postgres, which would be a fourth engine's rule imported into a repo that has no Postgres backend.
- *Non-ASCII / NFC-NFD collisions* → **already refused everywhere; no new rule.** `IDENTIFIER` is ASCII-only, so `café` and `cafe`+U+0301 are both rejected as identifiers and the case-shaped collision is unreachable in another alphabet. I made this load-bearing rather than incidental: it is *why* `fold` can be `toLowerCase` (never `toLocaleLowerCase`) and be exact, with no dotted-I or eszett to get wrong. Written at the choice site and pinned by a conformance case, so a future loosening of the regex fails a test rather than silently re-opening the hole.
- *Collision with the store's reserved space, beyond `_`* → **two real instances, answered differently.** (a) A backend's own DERIVED names: SQLite's `${entity}_open` index shared a namespace with entity tables. Fixed by construction (prefix `_`), so the declaration became legal everywhere rather than refused. I rejected the alternative — refusing an entity whose name equals another entity's derived index name — because it makes a declaration's legality depend on which *other* entities sit beside it, and leaks this store's naming scheme into the shared surface. (b) SQLite's own `sqlite_` namespace: unfixable by construction, so refused, in the SQLite package, at construction time. **This is deliberately NOT a seam rule**, for exactly the reason `entity-identifier-sql-keyword` kept the keyword list out: it is one engine's namespace and means nothing to a key-value store. Touches: `@etherfold/state-store-sqlite` only; a `sqlite_` entity stays legal on memory/patch/IndexedDB.
- *All of it at entity, id-column and field level* → the case rule applies at all three. The `sqlite_` rule applies to entity names **only**, because a `sqlite_` column is legal in SQLite (verified) and refusing one would be the same defect pointing the other way: this backend narrowing the seam for no engine reason. That non-refusal has its own probe, so it cannot be "tidied up" into a blanket prefix ban later.

**How a backend-specific limit lives in a shared suite.** `DECLARATION_PROBES` asserts a disjunction — the factory throws, *or* migrate + write + read-back succeeds — rather than a fixed outcome per backend. This is the one shape that lets the suite forbid the actual defect (accepted-then-fatal, accepted-then-divergent) without the suite having to know which engine refuses what. Alternative considered: per-backend expected-refusal lists in the suite, rejected because it puts every engine's vocabulary in the shared package, which is the thing this whole line of work is avoiding. Touches: every backend that adds this version of the suite; a backend that dies at `migrate()` on any probe now goes red.

**Renaming the derived indexes is a break for a stored DATABASE, not for a declaration.** An existing database re-migrates cleanly (`IF NOT EXISTS`) and keeps its old `token_open` etc. as redundant duplicates of the new `_token_open`; the unique-open-version invariant is enforced by both, so nothing is wrong, only wasteful. Named in the changeset. Alternative considered: emitting `DROP INDEX` for the old names, rejected because this package has no migration-versioning concept and inventing one to tidy indexes is a much bigger change than the defect warrants.

**"Probe" reused rather than a new word.** The conformance package already uses "probe" for a store used to read capabilities; `DECLARATION_PROBES` is a declaration used to interrogate a backend's limits. Same sense (a thing used to interrogate), so I reused it instead of coining a second term. Flagging it because it is the kind of near-miss the coherence check exists for.

**No ADR.** Both halves are easy to reverse (the case rule is one function; the index prefix is one template string) and the trade-offs are written at the choice sites plus the changeset, so neither clears the ADR gate. ADR-0018's "the rule is set by the strictest backend and applied uniformly" already covers the seam-vs-backend split this used.
