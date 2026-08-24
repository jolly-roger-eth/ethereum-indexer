---
title: Index in a browser tab with an entity processor, on a backend the app chooses
slug: index-in-the-browser-with-a-chosen-backend
spec: one-processor-everywhere
blockedBy: [backend-neutral-entity-event-processor]
covers: [1, 6]
---

## What to build

The last connection that makes the spec's headline true for a real application: an app indexes in a browser tab, with the SAME processor a server runs, on a storage backend chosen by one line of configuration.

Both halves exist and they are not joined. `createBrowserStateStore` (`packages/browser/src/storage/state-store/BrowserStateStore.ts`) builds a browser `StateStore`, defaults to IndexedDB on measured evidence (ADR-0024), takes a `backend` factory so an app can pick the patch store instead, and the IndexedDB store passes the shared conformance suite on Chromium, Firefox and WebKit with four tabs against one database. That work is real.

**And it is referenced by nothing except its own test.** The browser's indexing hook, `packages/browser/src/IndexerState.ts`, takes an `EventProcessorWithInitialState` — the free-form-object interface `@etherfold/js-processor` produces — so there is no way to hand it an entity processor at all. The result is that a user cannot today choose "server or in-browser" for one processor outside a test file.

`backend-neutral-entity-event-processor` provides the missing piece (an `EventProcessor` over any `StateStore`). This task consumes it from the browser.

**Do not break the existing hook.** Its current processor type is what shipped apps pass; `@etherfold/browser` is published and the free-form path is not deprecated by this spec. The hook should accept EITHER an `EventProcessorWithInitialState` or the entity-processor-over-a-`StateStore` shape, and the discrimination should be a type the caller cannot get wrong, not a runtime sniff of which fields happen to be present.

Two concrete places the current hook assumes the free-form shape, both in `packages/browser/src/IndexerState.ts`:

- It calls `processor.createInitialState()` unconditionally. An entity processor has no initial state to create, because its state lives in the store and is read back rather than seeded.
- It takes an optional `keepState` and throws `this processor do not support "keepState" config` if the processor cannot accept one. That optionality is already the right shape and needs no change: an entity deployment simply passes no keeper, because the store persists both the rows and (after `backend-neutral-entity-event-processor`) the cursor. Do not invent a keeper for the entity path, and do not make one mandatory.

**`KeepState` stays, and it belongs to the OTHER path.** It persists `AllData = {state, lastSync}` — state and cursor together as one blob — which is exactly right for a `JSObjectEventProcessor` whose state is an opaque object it cannot persist itself, and exactly wrong for an entity processor whose store already owns the state. So after this task there are two persistence models living side by side on purpose: keeper-persists-everything for the free-form path, store-persists-everything for the entity path. Say that where a reader will meet it, because the obvious instinct on finding two is to unify them.

**Keep the two IndexedDB seams apart, because their names invite exactly this confusion.** `keepStateOnIndexedDB` is a `KeepState` keeper: it serialises the WHOLE state object of a `JSObjectEventProcessor` on every save, which is why it is the fastest writer at today's sizes and why it cannot answer an as-of read or revert. `createBrowserStateStore` builds a `StateStore` of versioned rows. Both must keep working, they are not alternatives to each other, and `BrowserStateStore.ts` already carries the paragraph explaining the difference. If your change makes it possible to pass one where the other is meant, that is a defect.

**The cursor has to survive a reload, and that is the browser-specific risk.** A server keeps its cursor next to its state in the same database. Whatever `backend-neutral-entity-event-processor` decided for cursor persistence, this task is where it meets a real browser: a tab that indexes, is closed, and is reopened must continue rather than re-index from the start block. The patch store is memory-only and `revert-only` by design (ADR-0023), so on that backend a reload legitimately starts over; that difference must be visible to an app author rather than surprising them.

**Note what this does NOT include.** No HTTP query endpoint: the spec puts the GraphQL frontend out of scope and says the example ships hand-written routes, and `createReadSurface` is the in-process typed surface an app reads through. No server-side ingestion endpoint: `ingest-wire-receiving-side` (spec `historical-state-database`) owns that and is already eligible.

**A runnable example is REQUIRED, and it is the point of the task rather than a garnish.** The four `examples/event-processor-*` lost their run path when `ethereum-indexer-server` was archived, so nothing in this repository currently demonstrates indexing end to end, on any path, old or new. A test proving the wiring works is necessary and not sufficient: the claim being made is that an application developer can do this, and the only honest evidence for that is an application that does it.

So pick ONE example, give it a browser entry point, and make it genuinely run in a tab against a real chain, storing to the IndexedDB default. It must start from a documented single command, and its README must say what to run and what a reader should see happen.

If the build tooling for this turns out to dwarf the wiring it demonstrates, that is a REPORTABLE finding and a reason to route to needs-attention saying so, NOT a reason to quietly downgrade this to a test and call the task done.

## Acceptance criteria

- [ ] A test indexes a captured stream in a browser through the hook, using an entity processor, and lands on the expected state. It runs in the existing `playwright-browser-harness` style rather than new harness plumbing.
- [ ] The backend is chosen by configuration and the processor is untouched: the same processor definition runs on the IndexedDB default and on the patch store, demonstrated rather than asserted.
- [ ] The existing `EventProcessorWithInitialState` path still works, its tests still pass unchanged in meaning, and a caller cannot silently pass the wrong processor kind (it is a type error, not a runtime surprise).
- [ ] `keepStateOnIndexedDB` and `createBrowserStateStore` both still work and cannot be confused for one another at the type level.
- [ ] Reload continuity: an interrupted browser index resumes from its cursor rather than re-indexing from the start block, tested on the persistent backend. On the memory-only patch store the start-over behaviour is explicit and documented rather than incidental.
- [ ] Reorg works through the browser path, including a counter that decreases.
- [ ] One `examples/event-processor-*` indexes in a browser tab against a real chain, storing to the IndexedDB default, started by ONE documented command, with a README saying what to run and what to expect.
- [ ] Switching that example to the patch store is a one-line change that touches no processor code, shown in the example or its README.
- [ ] Tests in the package's `test/`, plus a changeset for any published package whose surface changed.

## Blocked by

- `backend-neutral-entity-event-processor`: there is no `EventProcessor` over an arbitrary `StateStore` to hand the browser hook until it lands.

## Prompt

> Make a browser tab index with an entity processor, on a backend the application chooses, in the `etherfold` monorepo (the repository directory is still named `ethereum-indexer`).
>
> FIRST read `work/specs/tasked/one-processor-everywhere.md` (user stories 1 and 6), confirm `backend-neutral-entity-event-processor` landed and note where it put the sync cursor, then read `packages/browser/src/IndexerState.ts`, `packages/browser/src/storage/state-store/BrowserStateStore.ts`, `packages/browser/test/browserStateStore.test.ts` and ADR-0024.
>
> The situation is that both halves exist and nothing joins them: `createBrowserStateStore` builds a browser `StateStore` and is referenced by nothing but its own test, while the indexing hook takes an `EventProcessorWithInitialState` and therefore cannot be handed an entity processor at all.
>
> Do not break the existing hook: `@etherfold/browser` is published and the free-form path is not deprecated. Accept both processor kinds, discriminated by TYPE rather than by sniffing which fields a value happens to have.
>
> Keep `keepStateOnIndexedDB` and `createBrowserStateStore` distinguishable. They both write to IndexedDB and they are different seams — one serialises a whole state object per save and keeps no history, the other is versioned rows. `BrowserStateStore.ts` already explains it. Making it possible to pass one where the other belongs is a defect, not a convenience.
>
> The browser-specific risk is reload continuity: a tab that indexes, closes and reopens must continue from its cursor, not re-index from the start block. Test it on the persistent backend. The patch store is memory-only by design (ADR-0023), so starting over there is correct — make that visible to an app author rather than a surprise.
>
> Out of scope, deliberately: no HTTP query endpoint (the spec puts GraphQL out of scope and `createReadSurface` is the in-process surface), and no server-side ingestion (`ingest-wire-receiving-side` owns it).
>
> A runnable example is REQUIRED here, not optional. Nothing in this repository currently demonstrates indexing end to end on any path, and a passing test is not evidence that an application developer can do this — an application doing it is. Pick one `examples/event-processor-*`, give it a browser entry point, one documented start command, and a README saying what to expect. If the build tooling for that dwarfs the wiring it demonstrates, route to needs-attention and say so; do not silently downgrade it to a test.
>
> Done means: an application developer writes one processor, picks IndexedDB or the light store with one line, and indexes in a tab — with the same processor a server runs.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your final report, in particular how the two processor kinds are discriminated and what happened with the example.
