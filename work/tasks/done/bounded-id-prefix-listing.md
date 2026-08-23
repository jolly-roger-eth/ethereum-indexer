---
title: Give MutationContext a bounded listing by id prefix, so ordered children need no hand-maintained index
slug: bounded-id-prefix-listing
spec: one-processor-everywhere
blockedBy: [portable-mutation-context-seam]
covers: [1, 2]
---

## What to build

The one read the entity model is missing: from a handler, list the rows whose declared id STARTS WITH a given prefix, with a required limit.

`MutationContext` is get / set / delete BY ID with no listing, and the port in `work/notes/findings/sqlite-in-the-browser.md` shows exactly what that costs. A handler cannot ask "which rows belong to epoch N", so an ordered bounded array became THREE entities plus a CSV of positions maintained by hand purely so a cascade delete had something to walk, and one `pop()` became an O(cells x players) loop of manual deletes against a foreign key the store could not answer in the direction needed. That path ran 100 times on the real stream, so it is not hypothetical.

The fix is not declarative aggregation. The Graph's schema language solves the same problem with `@derivedFrom`, a virtual field that is "never actually created during indexing": children are their own entities keyed by their parent, and the collection is derived WHEN READ. Their *Avoiding Large Arrays* post is precisely that advice. So the model needs the read side that makes the idiomatic shape expressible from a handler, and nothing more.

**The bound is the decision, not an implementation detail.** The listing takes a prefix of the DECLARED id plus a REQUIRED limit. It does not take an arbitrary `where` clause and it does not take a caller-supplied `orderBy`. That is what makes an accidental full scan impossible by construction, and it is what keeps the operation a single indexed range scan on every backend: a primary-key prefix scan in SQLite, an `IDBKeyRange.bound([epoch], [epoch, []])` cursor in IndexedDB, a sorted walk in memory. It costs nothing at write time, which is the property that distinguishes it from materialising counts. Ordering is the id's own ordering, ascending, because that is what a range scan gives for free; if a handler needs arrival order rather than key order, that is a MODELLING answer (key the child by `(blockNumber, logIndex)` or an event ordinal), not a parameter.

Note that `VersionedStateStore` already has `queryCurrent` / `queryAsOf` taking caller-supplied SQL. Those stay as they are: they are the server-side read layer, where a query planner exists and the caller is not running once per event. This task is about the HANDLER seam, which must be cheaply implementable by every backend including the ones with no planner.

The listing must honour read-your-writes within the block, the same as `get`: a row written earlier in the block appears in the listing, a row deleted earlier in the block does not. That is the part most likely to be got wrong, because it means merging the block's staging area into the range scan rather than reading the store alone.

## Acceptance criteria

- [ ] `MutationContext` exposes a listing taking an entity, a prefix of the declared id, and a required limit, and returns rows in the id's ascending order.
- [ ] Omitting the limit is a TYPE error, not a runtime default. A prefix that is not a leading subsequence of the declared id columns is a clear error naming the entity and the columns.
- [ ] There is no way to pass a predicate, a sort or an offset through this surface. (An accidental full scan should be impossible to express, not merely discouraged.)
- [ ] Read-your-writes: a test where one event in a block writes two children and deletes a third, and a later event in the SAME block lists the prefix and sees exactly the surviving set.
- [ ] The SQLite implementation is a single indexed range scan against the existing primary key, asserted by pinning the generated statement's shape (the repo already builds statements as plain data for exactly this kind of assertion).
- [ ] As-of correctness: listing a prefix as of an old block returns the children that were live at that block, not the current ones.
- [ ] A test models an ordered bounded child collection the way the spec's modelling rule says to (children keyed by a naturally unique ordered key, no stored array, no count) and shows the eviction case working with no hand-maintained index.
- [ ] Tests in the affected packages' `test/`, vitest, plus a changeset for each package whose public surface changed.

## Blocked by

- `portable-mutation-context-seam`: the surface this extends must exist in its backend-neutral home first, or the listing lands in the SQL package and has to be moved again.

## Prompt

> Add a bounded listing by id prefix to the processor authoring seam in the `etherfold` monorepo, so that a handler can ask about a SET of rows without a hand-maintained index.
>
> FIRST, check this task against current reality: read `work/specs/proposed/one-processor-everywhere.md` (or `work/specs/tasked/`), the entity-model decisions in it, and `work/notes/findings/sqlite-in-the-browser.md`, whose contortion list is the evidence for this task. Confirm `portable-mutation-context-seam` landed and that the seam is where this task assumes. If it landed differently, route to needs-attention rather than building on the stale premise.
>
> The vocabulary: an entity's DECLARED ID is an ordered list of business-key columns (`['epoch', 'position', 'playerIndex']`); a PREFIX is a leading subsequence of it (`{epoch}`); a version is a complete row with a half-open block-validity range, so a listing is a range scan under the validity predicate. READ-YOUR-WRITES means the block's staged mutations are visible to a later handler in the same block, which for a listing means merging the staging area into the scan.
>
> The design constraint is the point of the task, so do not relax it: prefix plus REQUIRED limit, no `where`, no `orderBy`, no offset. The reason is that a handler runs once per event on every backend, including ones with no query planner, and the one shape that is an indexed range scan everywhere is a key-prefix range with a bound. `VersionedStateStore.queryCurrent` / `queryAsOf` already take SQL predicates and are NOT this surface; leave them alone.
>
> Read the finding's contortion 1 and 2 before designing the API. They describe a real ordered bounded array (`placements`, evicting past seven entries, dropping everything nested under the evicted entry) that cost three entities plus a CSV index, and a hand-maintained count that existed only because a child id ended in a dense array position. Both should be expressible without contortion once this lands; make one of them a test.
>
> Done means: a handler can model a one-to-many the way the subgraph's `@derivedFrom` does (children keyed by their parent, collection derived when read), on every backend, with no write-time cost.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your final report, in particular anything about ordering guarantees, what happens when the limit truncates the result, and whether a truncated listing is distinguishable from an exact one.

## Decisions

- **Ordering is LEXICOGRAPHIC over the stringified id, not numeric** (`'10'` before `'9'`). Chosen because that is the order a key-prefix range scan produces for free on every backend, and because id columns carry no declared type (`fields` excludes them), so a numeric order would need type information the declaration does not have and would diverge from the index's own order. Alternative considered: sort numerically when a value parses as a number — rejected, it makes the seam's order differ from the backend's and is unstable across mixed values. Consequence, documented in the authoring README and ADR: a numeric child key must be fixed-width/zero-padded, and arrival order is a modelling answer (`(blockNumber, logIndex)`), never a parameter. Touches: `promote-stratagems-conformance-workload` (the port's keys), every future backend's ordering.
- **Truncation is REPORTED, not inferred: `list` returns `{rows, truncated}`,** and every backend fetches `limit + 1`. Alternatives considered: return a bare array and let the caller compare `rows.length` to the limit (rejected: an exact fill is indistinguishable from a cut-off one, and a cascade delete that guesses wrong leaves orphans silently — the same "plausible wrong answer" this seam refuses elsewhere), and throw when the set exceeds the limit (rejected: a handler legitimately lists a bounded head of a large set). Touches every caller's return-type shape and the conformance contract.
- **An EMPTY prefix is REFUSED; a listing must name at least the first id column.** This is the one place I let a measurement decide: `EXPLAIN QUERY PLAN` shows that unanchored (`WHERE _upper IS NULL ORDER BY <id> LIMIT ?`) SQLite abandons the id index and adds `USE TEMP B-TREE FOR ORDER BY`, so "the whole entity, bounded" would quietly break the one property the shape exists to guarantee. Alternative: allow it and accept a sort on that path — rejected as the surface's own claim becoming conditional. Consequence: "the first N rows of a table" is not expressible at the handler seam; it belongs above it. New user-visible refusal.
- **The limit is a required POSITIONAL `number`, not an options bag,** and a limit that is not a whole number ≥ 1 is a new runtime error. An options bag is an extension point by convention, and this surface's whole point is that it has none; positional leaves nowhere to hang a `where`/`orderBy`/`offset`. Pinned by two `@ts-expect-error` assertions that `pnpm typecheck` runs.
- **Names: `list` on `MutationContext`, `listCurrent` / `listAsOf` on `StateStore`.** Coherence check against CONTEXT.md: "list" meant nothing yet; `listCurrent`/`listAsOf` mirror `getCurrent`/`getAsOf` (same axis, same retention refusal) and stay deliberately distinct from `queryCurrent`/`queryAsOf`, which keep their meaning as the SQL-taking, above-the-seam surface. Both are REQUIRED of every backend, so `light-store-behind-the-seam` and `indexeddb-row-backend-browser-default` must implement them (an `IDBKeyRange.bound` cursor and a patch-log walk respectively).
- **A row staged in the current block is COMPLETED before it is listed** (id columns added, unlisted declared fields as `null`), so a listing's rows have one shape whether they came from the store or from the block. This makes `list` disagree with `get`, which still answers a staged key with only the values that were written; I did not change `get` (out of scope) and captured the asymmetry as an observation instead.
- **`VersionedStateStore.listAsOf` widens `at` to a `BlockAddress`** exactly as `getAsOf` already does, so hash/height/timestamp all work and the seam still only sees a resolved number. Follows the ADR-0018 decision rather than re-opening it.
- **The conformance fixture set gained a fourth entity, `placement` (`['epoch','position','playerIndex']`).** Every backend factory is handed it, which is a (small) cost to every future backend; a three-column id is what makes a PREFIX testable at more than one length.
- **Recorded as ADR-0021** (`docs/adr/0021-the-handler-seams-only-set-read-is-a-bounded-id-prefix-listing.md`): hard to reverse (public authoring API of two published packages), surprising without context (a read surface with no `where` looks like an oversight), and a real trade-off (questions pushed into modelling or above the seam).
