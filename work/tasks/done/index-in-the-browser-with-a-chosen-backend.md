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

**On `KeepState`: the INVARIANT is fixed, the interface is not.**

What must hold is that a processor's state and its cursor never diverge — a reader must never come back to state that has advanced past its recorded position, or vice versa, however the process died. Both existing paths honour that, by different means: the entity path will write the cursor in the block's transaction (`backend-neutral-entity-event-processor`), and the free-form path bundles `AllData = {state, lastSync}` into a single keyed write (`packages/browser/src/storage/state/OnIndexedDB.ts` does one `set()` of the whole object). The bundling is not an accident of history; it is that path's atomicity mechanism.

What is NOT fixed is `KeepState` itself. It was shaped when an injected keeper was the only way a free-form processor could persist anything, and that is no longer true: `@etherfold/state-store-indexeddb` exists, an IndexedDB transaction can span object stores, and this repository is free to design the API it wants rather than the one it inherited. So if, while wiring the entity path, a shape emerges that serves BOTH paths better — one persistence surface, one cursor story, a keeper reduced to the blob-writing it actually does — you may take it, provided the invariant above survives and the free-form path keeps working.

What you must NOT do is unify them by making the entity path store its state twice (the store already owns the rows) or by dropping the free-form path's atomicity to match an interface. And do not let this task grow into that redesign: if the better shape is real but large, describe it and leave it — there is a `work/notes/ideas/` note for exactly that, and a two-path status quo is an acceptable end state for this task.

Whichever way it lands, say where a reader will meet it which path persists what, because finding two persistence models with no explanation invites someone to unify them wrongly.

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

## Decisions

**The two processor kinds are discriminated by an explicit TAG the caller writes (`{kind: 'entities', processor}`), not by structure.** Chosen because both kinds are `EventProcessor`s and the only structural difference is `createInitialState` vs `state` — a sniff a wrapper, proxy or decorator can make wrong in silence, and the wrong branch does not throw, it seeds the UI store with the wrong value and indexes on. Alternatives considered: (a) a second factory `createEntityIndexerState` (the task asked for one hook that accepts either); (b) a structural union with no tag (TS would resolve it, but a runtime `'createInitialState' in p` check would still be a guess). The union is deliberately SYMMETRIC — `{kind: 'js-object', processor}` exists even though nobody has to write it — so the language has two named kinds rather than one tag plus an untagged "other". The bare processor stays the shorthand for `'js-object'`, so nothing published breaks. **Touches:** `@etherfold/browser`'s public surface, `updateProcessor`, `options.createIndexer` (widened to `EventProcessor`), and any future host that wraps the hook (e.g. `examples/web-demo`'s `createIndexeInitializer`, which needs no change). Recorded in `CONTEXT.md` as **processor kind**. No ADR: it is a naming/shape choice covered by the glossary and reversible by adding an overload, not a hard-to-reverse trade-off.

**`keepState` on the entity path is a runtime REFUSAL, not a type error.** Making it a compile error needs the options type to depend on the tag, which means overloads with an explicit return type for a hook whose return type is a large inferred object literal including `withHooks(){...this}`. The task also said the `keepState` optionality "is already the right shape and needs no change". So it throws, with a message naming `createBrowserStateStore` and the store. **Touches:** anyone passing a keeper; the existing free-form refusal (`this processor do not support "keepState" config`) is unchanged in wording and meaning.

**`@etherfold/utils` gained a `./indexer` subpath, and `@etherfold/browser` imports `contextFilenames` from it.** This is a fix to a package the task did not name, and I made it because the required deliverable is impossible without it: `@etherfold/utils`' barrel re-exports `contracts.ts` and `processorSetup.ts`, whose top-level `node:fs` / `node:path` / `node:module` imports mean `import '@etherfold/browser'` does not resolve for esbuild or vite — before tree-shaking can drop them. Alternatives rejected: copying `contextFilenames` into the browser package (it is the naming scheme a published snapshot is fetched under, so the CLI and a browser client MUST agree — a copy is a drift waiting to happen); making the node imports lazy (turns synchronous functions async). The barrel is unchanged, so nothing existing moves. **Touches:** `@etherfold/utils`' published export map (additive, in the changeset), and `bootstrap-an-entity-store-from-a-snapshot`, which will read the same filenames. Pinned by `test/bundlesForABrowser.test.ts` so it cannot regress silently.

**The example keeps BOTH processors, and the browser demo runs the entity one.** `examples/event-processor-nfts/src/index.ts` (free-form `JSProcessor`) stays because `examples/web-demo` imports `createProcessor` from it and the free-form path is not deprecated; `src/entities.ts` is the same question written against the seam. Alternative rejected: converting the example wholesale, which would break `web-demo` (out of scope). The README frames the duplication as the one place where the two authoring styles sit side by side, so the porting cost is readable in a diff. **Touches:** `examples/web-demo` (unaffected — it still builds).

**The example's start script is `browser`, not `dev`.** In this repo `dev` means "watch the sources and rebuild the package" in every package and example, and the root `start:pnpm` is `pnpm -r dev`; giving `dev` a second meaning in one example would have silently added a Vite server to that command. Documented command is `pnpm --filter event-processor-nfts browser`. **Touches:** the root `start` / `start:pnpm` scripts (deliberately not).

**The example defaults to a public RPC (`https://rpc.mevblocker.io`) and BAYC on mainnet, with `?rpc=` / `?contract=` / `?blocks=` overrides, and uses an injected wallet when there is one and no `?rpc=`.** "Against a real chain" needs a real endpoint, and a demo that requires a wallet is not one command. I verified this endpoint serves `eth_getLogs` with `blockTimestamp` (which the entity path needs to record a block) and sends CORS headers; several other free endpoints refuse historical `eth_getLogs` outright. The README says public endpoints rate-limit and come and go, and points at the override. **Touches:** nothing in the packages; it is an example default a reader can change in the URL bar.

**The example remembers its start block in `localStorage`.** `startBlock` is part of the indexing source and the source is hashed into the sync context, so a start block recomputed as `tip - 2000` on every load would make each reload a different deployment, discard the state as stale, and make the reload-continuity claim untestable by construction. Alternative rejected: a hard-coded start block (goes stale, and the demo's run length would grow without bound).

**The `resume` line in the example reports the first `eth_getLogs` range, not the state.** Resuming and re-indexing end on the same rows, so the state cannot say which happened; the fetched range can. The node and browser tests assert the same property the same way.
