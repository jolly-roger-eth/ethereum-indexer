---
title: The row-level IndexedDB backend, and make it the browser default with an ADR stating the condition
slug: indexeddb-row-backend-browser-default
spec: one-processor-everywhere
blockedBy: [portable-mutation-context-seam, retention-capability-and-refusal, state-store-conformance-suite]
covers: [6]
---

## What to build

A versioned entity store on IndexedDB, behind the seam, passing the conformance suite, wired as the browser DEFAULT, with an ADR recording why and what would overturn it.

The choice is decided by measurement, not preference. On the real workload (the launched stratagems game on Base: 31,332 events, 1,042 event-bearing blocks, 38,192 mutations, 4,072 live rows), IndexedDB beats wasm SQLite on writes by 1.6x to 6.9x and on reads by 4x to 14x, on every engine that can run both. Chromium: 45.6 ms/block and 305 us/read against 74.2 and 1,246. Firefox: 10.0 and 155 against 30.1 and 490. WebKit cannot run the SQLite route at all (`Missing required OPFS APIs`), where it silently degrades to an in-memory database that loses everything on reload.

**The ADR is part of this task, and it should state the condition rather than the preference**, because a bare "we use IndexedDB" invites reversal the first time someone reads a SQLite benchmark. The condition under which wasm SQLite would win is all FOUR of these at once: a Chromium-only target (Chromium's IndexedDB write path degrades roughly 10x as the store grows, putting a crossover between about 5,000 and 13,000 live rows, while Firefox and WebKit do not degrade at all and never cross); a live set past that crossover and still growing (this game peaked at 4,072); single-tab by construction or willing to build leader election (three of four tabs FAIL AT OPEN on both SQLite VFSs, `createSyncAccessHandle` on `opfs-sahpool` and `SQLITE_BUSY` on `opfs`, while IndexedDB ran four of four with zero mismatches); and an app that can afford 501.9 KB gzipped plus a 130 to 190 ms cold start on every load and does not need Safari. The overturning criteria belong in the ADR too, and they are in the finding: a TUNED IndexedDB backend (the measured one is a prototype, and read-before-write was tested and EXONERATED as the cause, so the degradation is in Chromium's write path itself), Chromium changing that implementation, a live set an order of magnitude larger, multi-tab getting a real answer on the SQLite side, or query shapes IndexedDB cannot serve (everything in this workload is point and as-of reads BY ID; filtered, sorted, paginated or joined queries over a large local set is where SQLite's 20-to-100x advantage would decide it).

The spike's prototype (`docs/spikes/sqlite-in-the-browser/src/store/idb.ts`) is a starting reference, not code to copy wholesale: it was written to be measured, not shipped. It does contain the parts worth keeping, notably the range-scan shape a prefix listing needs (`IDBKeyRange.bound([epoch], [epoch, []])`) and a prune.

Also note what it must beat honestly. The incumbent whole-state blob is FASTER at today's sizes (2.0 ms/block on Chromium against 45.6). Row-level writes buy history, revert, bounded cold start and a write cost that stops tracking total state; they do not buy throughput at 4,072 rows. Do not ship a claim the first benchmark contradicts.

This task does NOT ship a wasm SQLite browser backend. If the condition above is ever met, the `remote-sql` browser adapter is another repository's work (see the spec's Out of Scope).

## Acceptance criteria

- [ ] An IndexedDB-backed store implements the seam's backend interface and passes the shared conformance suite in a real browser, on Chromium, Firefox and WebKit.
- [ ] It reports its retention capability honestly, and if it enforces a window it prunes; if it does not prune yet, it reports `unbounded`.
- [ ] The prefix listing is an `IDBKeyRange` cursor, not a full scan with a filter. Asserted, not assumed.
- [ ] It is the browser default, selectable by configuration, and choosing another backend is a configuration change that touches no processor code.
- [ ] Multi-tab: four tabs against one database complete with zero row mismatches (the case both SQLite VFSs fail at open).
- [ ] An ADR in `docs/adr/` records the decision as a CONDITION: the four things that would have to be true at once for wasm SQLite to win, and the five criteria that would overturn the choice, with the measured numbers and a pointer to `work/notes/findings/sqlite-in-the-browser.md` and `docs/spikes/sqlite-in-the-browser/results/`.
- [ ] Browser tests run in the existing harness style (the spike used `playwright-browser-harness`; do not rebuild harness plumbing).
- [ ] Tests in the package's `test/`, plus a changeset.

## Blocked by

- `portable-mutation-context-seam`: the backend interface.
- `retention-capability-and-refusal`: the capability report it must fill in honestly.
- `state-store-conformance-suite`: the suite it must pass; without it this is an unverified second implementation, which is the drift the spec exists to prevent.

## Prompt

> Build the row-level IndexedDB storage backend for the `etherfold` monorepo, make it the browser default, and record the decision as an ADR stating the condition under which it would be reversed.
>
> FIRST, check this task against current reality: read `work/specs/proposed/one-processor-everywhere.md` (or `work/specs/tasked/`), confirm `portable-mutation-context-seam`, `retention-capability-and-refusal` and `state-store-conformance-suite` landed as assumed. Read `work/notes/findings/sqlite-in-the-browser.md` IN FULL before writing the ADR: it is the measured evidence, and the ADR's whole value is carrying its condition and its overturning criteria next to the code. The raw output is `docs/spikes/sqlite-in-the-browser/results/`; do NOT re-run or re-litigate the measurements.
>
> The vocabulary: a VERSION is a complete row with a half-open block-validity range; AS-OF is a read at a past block address; RETENTION is a declared capability in BLOCK NUMBERS; the PREFIX LISTING is a bounded range scan by a leading subsequence of the declared id, which on IndexedDB is an `IDBKeyRange.bound([prefix], [prefix, []])` cursor.
>
> `docs/spikes/sqlite-in-the-browser/src/store/idb.ts` is the measured prototype: read it for the key shapes and the prune, but it was written to be measured rather than shipped, so treat it as reference.
>
> Two honesty constraints. The incumbent whole-state blob (`keepStateOnIndexedDB`) is FASTER than this at today's sizes (2.0 ms/block on Chromium against 45.6 measured for row-level writes), so do not describe this as a speed-up: it buys history, revert, bounded cold start, and a write cost proportional to what changed rather than to total state. And the ADR must state the CONDITION, not a preference, or it will be reversed by the first person who reads a wasm SQLite benchmark.
>
> Browser testing uses the existing harness (`playwright-browser-harness`, already built and verified on Debian, covering WebKit so Safari-engine evidence is reachable from Linux). Do not rebuild harness plumbing.
>
> Done means: the same processor that runs on the server runs in a browser tab on this backend, it passes the shared conformance suite on three engines, four tabs work, and the ADR tells a future reader exactly what would have to change for the answer to change.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your final report, and name the ADR you wrote.

## Decisions

**Package name and placement: `@etherfold/state-store-indexeddb`, class `IndexedDBStateStore`.** Read off ADR-0014/0016's axis (role first, backend last) with the trailing slot naming the substrate, and ADR-0018 already reserved "a production browser backend is a package of its own". Runtime dependencies are the seam and nothing else, asserted by `test/stays-a-primitive.test.ts`. Touches: the naming axis; it sits beside `state-store-patch` under the same rule.

**The "browser default" selection surface lives in `@etherfold/browser` as `createBrowserStateStore`, not in the store package and not in `@etherfold/processor-entities`.** A default is only meaningful at the layer where the choice is made: putting it in the IndexedDB package would make it pointless (a host choosing otherwise would never call it), and putting it in `processor-entities` would make the backend-neutral authoring package depend on a backend, inverting the naming axis. Alternatives considered: a factory registry (rejected: it would force the browser package to know every store), and no surface at all (rejected: the criterion asks for a configurable default). Touches: `@etherfold/browser` gains `@etherfold/state-store` and `@etherfold/state-store-indexeddb` as runtime dependencies and a minor version; whatever later wires an `EventProcessor` for the browser should build on this function rather than a second chooser.

**Coherence check on the new module's placement: `src/storage/state-store/` next to the existing `src/storage/state/`.** Both write to IndexedDB and they are different seams, so the collision is real: `storage/state/OnIndexedDB.ts` is a `KeepState` keeper for the whole-state blob, `storage/state-store/` builds a `StateStore` for entity rows. I kept the glossary's own words (`KeepState` vs `StateStore`) rather than inventing a third term, and the difference is spelled out at the top of `BrowserStateStore.ts` and in ADR-0024. Alternative considered: `storage/entities/` (rejected: "entity declaration" already means the author-facing `{name, id, fields}`, so it would re-mean an existing term).

**The config is a discriminated union: `{backend?: 'indexeddb', databaseName?, retention?, finalityDepth?}` or `{backend: factory}`.** The options configure the DEFAULT backend, so a custom factory (which has already been configured by its host) cannot be passed alongside them. Alternative: one flat object with options ignored for custom backends (rejected: a silently-ignored `retention` is exactly the kind of quiet wrongness this seam exists to prevent).

**User-visible default: `databaseName` defaults to `'etherfold-state'`.** A required name is more honest about collisions; a default is what makes the common single-indexer case one line. I chose the default and documented, on both the option and the README, that the name IS the identity of the state (several tabs of one app share it; two unrelated indexers must not). Touches anyone running two processors in one origin.

**New refusal: using the store where there is no `indexedDB` throws a named error** naming the alternatives (`state-store-sqlite` on a server, `MemoryStateStore` or `fake-indexeddb` in a test, or an injected factory) rather than a `TypeError` on `undefined.open`. It is raised lazily at first use, so importing or constructing in node is still fine.

**Three deliberate departures from the measured prototype (`docs/spikes/sqlite-in-the-browser/src/store/idb.ts`), recorded in ADR-0024.** (a) `versions` carries a `lower` and an `upper` index, so `revertTo` is two range scans and needs no per-block undo journal — the prototype's journal grows with every mutation ever applied and would have to be pruned, which would silently make deep reverts no-ops. (b) `prune` walks the `upper` index instead of scanning every version (the prototype's full scan took 6.3 s at 62,553 versions). (c) No tombstone versions: a delete only CLOSES the live version, which is what the seam's own model says and what memory/SQL do. The cost is write-time index maintenance the 45.6 ms/block figure did not pay, and **I did not re-measure** (the task says not to re-litigate the measurements); the ADR says so explicitly and files it under overturning criterion 1 ("a tuned IndexedDB backend").

**The entity name is part of the key; the schema is fixed at version 1.** An object store per entity would make "the processor declares one more entity" an IndexedDB version change, and an upgrade transaction can be BLOCKED by another open tab — which would break the multi-tab property this backend is chosen for. Touches any future backend feature that wants a new object store: it inherits the upgrade/blocked problem.

**The tip is read from the database on every use, never cached.** A retention window is a distance from the tip, and another tab (or a reload) can move it, so a cached tip would refuse reads that are inside the window or answer ones that are not. Only a windowed store pays the lookup, because `assertRetained` takes it as a thunk. Asserted in `test/persistence.test.ts`.

**Browser tests are a separate `test:browser` script and are NOT in the acceptance gate.** They need three Playwright browser binaries a clean CI checkout does not have, and a gate that cannot run in CI is a gate that gets skipped. The compensation is that the SAME shared suite runs in the gate under `fake-indexeddb`, and the browser run's output is committed under `docs/spikes/indexeddb-row-backend-browser-default/results/` so the ADR points at an observation. A `vitest.config.ts` in the package keeps vitest from collecting the Playwright `.spec.ts` files.

**The cross-backend processor-equality test lives in THIS package, not in `@etherfold/processor-entities`** — a deliberate deviation from the precedent `light-store-behind-the-seam` set. The browser harness needs `@etherfold/processor-entities` as a devDependency here (running the real processor in a tab is the point), so adding this store to that package's test graph makes the two packages cyclic and pnpm warns on every install. I verified that, then reverted it. The chain is still closed: this package asserts IndexedDB ≡ `MemoryStateStore` on one processor, and `processor-entities/test/two-backends.test.ts` asserts `MemoryStateStore` ≡ `@etherfold/state-store-sqlite`.

**Two mutations of one business key in one block resolve to the last of them.** A version here is keyed by `(id, lower)`, so a block opens at most one version per key, where the SQL backend keeps both (its version identity is a surrogate row id) and the extra one is a zero-width version no read can return. The two backends therefore ANSWER identically and differ only in what they store; `MutationContext` coalesces per key anyway, so it is only reachable by calling `applyBlock` directly. Documented at the method rather than turned into a new refusal.

**Small doc updates outside the new package, because they named this work as future:** `packages/state-store/src/memory.ts` and its README pointed at the task slug for "the browser answer" and now name the package; `CONTEXT.md`'s `StateStore` glossary entry lists the new backend.
