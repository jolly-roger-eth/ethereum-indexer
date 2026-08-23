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
