---
title: Close the two remaining paths where a read answers plausibly instead of refusing
slug: a-read-that-cannot-be-served-refuses
blockedBy: []
covers: []
---

## What to build

Two holes in the property `one-processor-everywhere` exists to guarantee: a read the store cannot serve must be a typed refusal, never a plausible answer. Both were found during the drive that built the seam, both were correctly left for their own task, and they are the same bug wearing two hats.

**1. An as-of read does not check that its block number is a block number.** (`work/notes/observations/as-of-read-does-not-check-its-block-number.md`)

`MemoryStateStore.getAsOf('token', {id: '1'}, {hash: '0x64'} as never)` returns `undefined`: `assertRetained` passes on an unbounded store, and the version predicate then compares an object against block numbers, matching nothing. The patch and IndexedDB backends type `at` as a number and do not check it either. It is reachable from JavaScript or through a cast, and the answer it produces is an ordinary "the entity was absent then" rather than the refusal every other unservable read gives.

The guard belongs at the SEAM, beside `assertRetained`, so one check covers every backend rather than three copies drifting. `@etherfold/state-store-sqlite` is the backend that legitimately takes a richer address (a height, `{hash}` or `{timestamp}`) and resolves it, so the seam-level guard must not break that: it constrains what reaches a backend whose `getAsOf` takes a NUMBER, and the SQLite path keeps its own resolution and its existing `NoSuchBlockError`.

Pick the error deliberately. This is not `BlockNotRetainedError` (the block is not outside a window, it is not a block at all) and it may not be `NoSuchBlockError` either (that means "resolved to no recorded block"). It may be an ordinary `TypeError`-class programmer error rather than a member of the `BlockUnavailableError` family, because a non-number `at` is a caller BUG and not a state of the store. Decide, and say why.

**2. `get` returns a partial row for a key staged in the same block.** (`work/notes/observations/staged-get-returns-a-partial-row.md`)

`get` served from the store returns the whole row (id columns, every declared field, version columns); `get` served from the block's staging area returns `{...staged.values}`, which is only what the handler passed to `set`. So an id column, or a declared field the write did not list, is `undefined` for a row written earlier in the SAME block and present for one written in an earlier block. The shape depends on timing.

`bounded-id-prefix-listing` already solved this for `list`, which fills the id columns and the unlisted declared fields for staged rows precisely so a listing's rows have ONE shape whatever they came from. So `get` and `list` now disagree, and `list` is the one that is right. Make `get` match it, and reuse the listing's staged-row construction rather than writing a second one that can drift.

This one is a silent-wrong-answer bug of the same family: a handler reading a field that is only sometimes there gets `undefined`, which is a legal value meaning "not set", not an error.

## Acceptance criteria

- [ ] A non-number `at` reaching a backend whose `getAsOf` takes a block number is refused with a typed error, on every backend, rather than returning `undefined`. The guard lives once, at the seam.
- [ ] `@etherfold/state-store-sqlite` still accepts a height, `{hash}` and `{timestamp}`, resolves them, and still throws `NoSuchBlockError` for an address that resolves to no recorded block. A test pins that this task did not narrow the addressing layer.
- [ ] The error chosen for a non-number `at` is a deliberate choice with its reasoning recorded, including whether it joins the `BlockUnavailableError` family or is a programmer-error type outside it.
- [ ] `MutationContext.get` returns the SAME row shape whether the row was written earlier in this block or in an earlier block: id columns present, declared fields the write did not list present as NULL.
- [ ] `get` and `list` build a staged row through ONE shared path, so they cannot drift apart again.
- [ ] A test writes a row earlier in a block, reads it back with `get` later in the SAME block, and asserts the id columns and an unlisted declared field are present — the case that is wrong today.
- [ ] Both cases are exercised by the shared conformance suite, so a new backend inherits them.
- [ ] Tests in the affected packages' `test/`, vitest, plus a changeset.

## Prompt

> Close the two remaining paths in the `etherfold` monorepo where a read answers plausibly instead of refusing.
>
> FIRST read `work/notes/observations/as-of-read-does-not-check-its-block-number.md` and `work/notes/observations/staged-get-returns-a-partial-row.md` (both were filed during the seam drive and deliberately left for this task), then `packages/state-store/src/memory.ts`, `src/mutation-context.ts`, `src/listing.ts`, `src/errors.ts` and `packages/state-store-sqlite/src/blocks.ts`.
>
> The vocabulary: an unservable historical read is a typed refusal of the `BlockUnavailableError` family (`BlockNotRetainedError` here, `NoSuchBlockError` in the SQLite package); `undefined` means the entity was genuinely absent then, which is an ordinary answer a caller acts on normally. That distinction is the whole point, and both bugs below break it by returning `undefined` where nothing legitimate was asked.
>
> Bug 1: a non-number `at` passes `assertRetained`, then matches no version, and comes back as `undefined`. Put the guard at the SEAM beside `assertRetained` so it covers every backend at once. Do NOT break `@etherfold/state-store-sqlite`, which legitimately takes a height, `{hash}` or `{timestamp}` and resolves it — the guard constrains backends whose `getAsOf` takes a NUMBER. Choose the error type deliberately: this is arguably a caller BUG rather than a state of the store, so it may belong outside the `BlockUnavailableError` family. Say which and why.
>
> Bug 2: `MutationContext.get` returns `{...staged.values}` for a row written earlier in the same block, so id columns and unlisted declared fields are missing — while the SAME row read in a later block comes back whole. `list` already does this correctly (`bounded-id-prefix-listing` fills staged rows so a listing has one shape); make `get` match `list`, through the SAME code path rather than a second implementation.
>
> Put both in the conformance suite so a future backend inherits them.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your final report, in particular the error type chosen for a non-number `at`.

## Decisions

- **A non-number `at` is `InvalidBlockNumberError extends TypeError`, outside the `BlockUnavailableError` family.** Every member of that family is a fact about the STORE (the address resolved to no block; the versions are outside retention), and a caller acts on one by re-pinning or widening retention. A non-number `at` is a fact about the CALL: no store configuration makes it answerable, so it is a programmer error, and a `catch (e) { if (e instanceof BlockUnavailableError) ... }` written for "my historical read did not happen" must not swallow it. Alternatives considered: (a) `BlockNotRetainedError` — wrong, the block is not outside a window, it is not a block; (b) a new member of the family — it would make "catch the family" mean two different kinds of news; (c) a bare `Error`, matching the repo's other caller-bug throws (`assertListingLimit`, `resolveRetention`) — rejected because the conformance suite has to assert a TYPE, not a message, or a backend could satisfy it by throwing anything. It touches: `@etherfold/state-store`'s public error surface, and `@etherfold/state-store-sqlite`'s height axis (below).
- **The guard sits INSIDE `assertRetained`, as its first statement, rather than as a separate call each backend makes.** "Beside `assertRetained`" as a sibling function would have meant three call sites to add and to keep. Placing it first also fixes WHICH refusal a caller gets: a `revert-only` store would otherwise report `{hash: '0x64'}` as "not retained" and send its owner off to widen a window that was never the problem. Consequence, and it is intended: `listAsOf` inherits the same guard, not just `getAsOf`.
- **`@etherfold/state-store-sqlite`'s HEIGHT axis now throws the seam's `InvalidBlockNumberError` instead of a bare `Error`** (same message, so existing assertions on `/block address/i` still hold). Reason: it is the identical caller bug on the other side of an addressing layer, and it is what lets ONE conformance case be honest for every backend, including one whose `getAsOf` legitimately takes a richer address. The malformed-SHAPE branch (`{}`, `{height: 101}`) keeps its plain `Error`: "this names no axis I have" is an addressing-layer concern that has no meaning at the seam. Touches: anyone catching that specific throw — it is still an `Error`, now also a `TypeError`.
- **The conformance case uses `{number: '100'}` as its non-block value** rather than the observation's `{hash: '0x64'}`. A hash is a LEGAL address on `@etherfold/state-store-sqlite`, which runs this same suite, so asserting a refusal for it would fail an honest backend; `{number: '100'}` is a caller bug on both sides of an addressing layer. The hash case is pinned where it belongs, in `@etherfold/state-store`'s own tests.
- **No ADR.** ADR-0015 already settles the family and its shape rule; this adds a non-member and a guard, whose rationale lives in the class doc, the changeset and the `CONTEXT.md` glossary entry. Say the word if you would rather it be an ADR.
