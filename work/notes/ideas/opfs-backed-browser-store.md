---
title: Try OPFS as a browser storage backend, not just as SQLite's VFS
slug: opfs-backed-browser-store
---

## The opportunity

`spike-sqlite-in-the-browser` measured three browser storage shapes behind one seam: versioned rows on IndexedDB, versioned rows in wasm SQLite, and the incumbent whole-state blob on IndexedDB. **OPFS appeared only as SQLite's VFS, never as a backend in its own right**, and that is the gap in the evidence. See `work/notes/findings/sqlite-in-the-browser.md` for the numbers this idea reacts to.

Two results from that spike make OPFS interesting rather than merely untried:

- **Chromium's IndexedDB write path degrades about 10x as the store grows** (180 to 1,822 us per mutation from empty to ~19k live rows), and caching the live set in memory did not help, so the cost is in the write path itself. OPFS does not use that path at all.
- **The SQLite route's cost is mostly the VFS, not SQLite**: the same wasm SQLite on `:memory:` did 39 us per mutation against 559 to 1,059 over `opfs-sahpool`. Which says the OPFS layer as SQLite drives it is expensive, and invites the question of whether driving it directly, with an access pattern chosen for it, is cheaper.

## What to try

OPFS is a FILE api, so "versioned rows on OPFS" means writing a file format and an index, which is re-deriving SQLite and is not the proposal. Two shapes that are not that:

1. **OPFS as the blob store**, replacing `idb-keyval` in `keepStateOnIndexedDB`. `createSyncAccessHandle` writes are about the fastest thing a browser can do to disk, and this keeps the incumbent's shape while bypassing IndexedDB entirely. Cheapest to try; likely beats the incumbent at its own game; changes nothing about the incumbent's real problem, which is that a write is O(total state).
2. **An append-only log of block mutations, plus the live set in memory, plus periodic compaction.** This is the interesting one. Writes are O(what changed) and strictly sequential, which is the access pattern OPFS is best at; history is free because the log IS the history; reads are memory speed; cold start is a log replay or a snapshot read. It is roughly the same amount of code as the IndexedDB backend already written in the spike, and on this workload's shape (median 7 mutations per block, bursts to 457, 4,072 live rows) it plausibly beats IndexedDB rows, wasm SQLite and the blob at the same time.

## What it inherits, and would have to answer

- **Worker-only, and exclusive per file.** The sync access handle is the fast path and it is Worker-only, so this inherits SQLite's structure. It also inherits SQLite's multi-tab problem: the spike measured three of four tabs failing outright on both SQLite VFSs, and an exclusive access handle behaves the same way. Leader election or a shared worker is part of the design, not an afterthought.
- **No coverage on Playwright's Linux WebKit**, which reports `hasOPFS: false`, exactly as it does for the SQLite fixture. Real Safari 16.4+ has OPFS (outside private browsing), so this is a testing gap rather than a platform gap, but it is the same gap that makes the SQLite route's WebKit story unverifiable here.
- **Compaction has to be scheduled, not inline.** The spike found pruning expensive enough to matter (6.3 s for a full IndexedDB scan, 1.1 s for SQLite prune plus `VACUUM`), and a compaction pass in the block path would show up as a stall.

## Why it is cheap to answer

The spike's harness takes a new backend as one more `BlockStore` and reuses every workload, trace, assertion and browser matrix already there: the real captured stream, the crossover sweep, multi-tab, the mid-range profile, footprint by retention. The marginal cost is the backend itself, not the measurement.

## When to actually do it

Not yet. The finding's recommendation (IndexedDB by default) holds at the size the real deployment reached, so this is an optimisation without a live problem. It earns its turn when either a consumer expects to pass roughly 5,000 live rows on Chromium, or the incumbent's O(total state) save becomes the bottleneck someone is actually feeling.
