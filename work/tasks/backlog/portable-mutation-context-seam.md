---
title: Lift MutationContext out of processor-sqlite into a backend-agnostic seam with declared capabilities
slug: portable-mutation-context-seam
spec: one-processor-everywhere
blockedBy: []
covers: [1, 2, 3, 4, 5]
---

## What to build

The seam itself: one authoring API that a processor is written against, and one backend interface that any store can implement, with the SQLite store as the first implementation behind it and a processor that runs unchanged on both sides of it.

Today `MutationContext`, `SQLProcessor` and the entity declarations live in `@etherfold/processor-sqlite` and `@etherfold/state-store-sqlite`, so the authoring API is spelled as if SQL were the only substrate. It is not: the direction of the constraint runs the other way, because `MutationContext` (`get` / `set` / `delete`, plus `update` sugar) is the MORE constrained surface, so a freer substrate can implement it while backing arbitrary nested object mutation with versioned rows cannot be done without materialising the store. Move the declaration types, the handler types and the write surface into a backend-neutral home, name it without the SQL, and define the backend interface the seam is written against: apply a block's mutations atomically, read current, read as-of, revert to a block, and REPORT WHAT IT CAN DO.

The capability report is part of this task even though its enforcement is not. A backend states its retention (`revert-only`, a window of N blocks, or `unbounded`) and whether it answers as-of reads, so a caller can discover at startup what is available instead of discovering it from a wrong answer. This task lands the shape and has the SQLite store report honestly (which, until pruning exists, means `unbounded`); the refusal semantics and the pruning are separate tasks that build on it.

Keep the semantics that already work and are load-bearing. `set` writes a WHOLE row, because a version is a complete row and the primitive should mirror the store's close-then-insert rather than hide it; `update(entity, id, partial)` stays sugar over get-then-spread-then-set. Handlers stay uniformly async: the alternative, typing reads as `T | Promise<T>`, is infectious at every call site to save a microtask on a path dominated by log fetching. Read-your-writes within the block being processed stays exactly as `processor-sqlite` documents it, and it is genuinely load-bearing rather than theoretical: on the real stratagems stream, 16,871 of 66,113 reads were served from the block's own staging area.

Naming and package layout are yours to decide, but decide them deliberately: the published names are `@etherfold/processor-sqlite` and `@etherfold/state-store-sqlite`, and ADR-0016 already says a processor package names where its state lives, so a new backend-agnostic package needs a name that does not contradict it. Migrating existing consumers is explicitly not a constraint (see the spec's Out of Scope).

## Acceptance criteria

- [ ] One processor written once against the seam runs, unmodified, against at least two backends in a test: the existing SQLite store and a trivial in-memory one. Same entity declarations, same handlers, same resulting state.
- [ ] The authoring types (entity declaration, `MutationContext`, the `on<EventName>` handler map, the processor's `version`) live in a package whose name does not imply SQL, and `@etherfold/processor-sqlite` consumes them rather than defining them.
- [ ] A backend reports its capabilities as data (retention kind plus window, and whether it answers as-of), reachable before any read is attempted.
- [ ] `set` writes a whole row and `update` is sugar over get-then-spread-then-set, with a test pinning that an unlisted declared field becomes NULL through `set` and survives through `update`.
- [ ] Read-your-writes within a block is tested at the seam, not only in the SQLite implementation: two events in one block touching one counter compose.
- [ ] The existing `processor-sqlite` and `state-store-sqlite` test suites still pass unchanged in meaning.
- [ ] Tests in the affected packages' `test/` directories, vitest, matching the repo's existing style, plus a changeset for every package whose public surface moved.

## Blocked by

- None, can start immediately.

## Prompt

> Lift the processor authoring API out of the SQLite packages so that one processor can run against several storage backends, in the `etherfold` monorepo (the repository directory is still named `ethereum-indexer`).
>
> FIRST, check this task against current reality. Read `work/specs/proposed/one-processor-everywhere.md` (or `work/specs/tasked/` if it has moved), `packages/processor-sqlite/src/types.ts` (the `MutationContext` and `SQLProcessor` doc comments are the design rationale and should survive the move), `packages/state-store-sqlite/src/types.ts` and `src/store.ts`, and ADR-0016. If the seam has already moved, route to needs-attention rather than duplicating it.
>
> The vocabulary: an ENTITY DECLARATION is `{name, id, fields}` and the store owns everything else (the DDL, the version columns, the as-of rewrite, the revert). A MUTATION CONTEXT is the write surface a handler gets for ONE block, with read-your-writes inside that block. A VERSION is a complete row with a half-open block-validity range, so `set` writes a whole row and `delete` closes the live version without opening a new one. RETENTION is how far back superseded versions are kept, and the finality depth is its floor because reorg revert already requires that much.
>
> The measured evidence that this seam is in the right place is `work/notes/findings/sqlite-in-the-browser.md`: a real, launched processor (13 handlers on Base) was ported to `MutationContext` and produced state byte-identical to the original `JSProcessor` on 31,332 real events. Read its contortion list before you touch the types, because two follow-on tasks change this surface: a bounded id-prefix listing is being un-parked (`bounded-id-prefix-listing`) and retention gains a typed refusal (`retention-capability-and-refusal`). Leave room for both; do not build them here.
>
> Done means: one processor, two backends, identical state, and a capability report a caller can read before it asks a question the backend cannot answer.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your final report, in particular the package name and what moved versus what stayed. If a choice meets the ADR gate (hard to reverse, surprising without context, a real trade-off), also write it as an ADR in `docs/adr/` and name it in the block.
