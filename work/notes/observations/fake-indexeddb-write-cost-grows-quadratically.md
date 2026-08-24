---
title: "`fake-indexeddb`'s write cost grows quadratically with store size"
slug: fake-indexeddb-write-cost-grows-quadratically
observed: 2026-08-24
source: 'task:promote-stratagems-conformance-workload, while timing the launched game''s replay on every backend'
---

Replaying the launched stratagems game's 31,332 events through `IndexedDBStateStore` on `fake-indexeddb` in node degrades super-linearly with the number of stored versions: 50 blocks in 0.3 s, 250 in 25 s, 500 in 271 s, which is roughly `mutations^2`. The same backend measured **45.6 ms/block on real Chromium** in `work/notes/findings/sqlite-in-the-browser.md` (so ~48 s for the whole stream), which says this is the SHIM's write path and not the backend's; a sorted-array insert per record is the obvious suspect, since the run inserts 29,393 version records.

Not touched here. `fake-indexeddb` is what keeps `@etherfold/state-store-indexeddb` honest between browser runs and it is fine for the conformance suite's small cases; it just cannot carry a heavy workload. `packages/conformance-workload-stratagems` therefore runs IndexedDB on the fast smoke fixture every invocation and leaves the launched game's full replay on that backend behind `STRATAGEMS_WORKLOAD=all`. If heavy-workload coverage on IndexedDB is wanted in CI, the honest route is the real engine (`packages/state-store-indexeddb/browser/`), not a faster shim.
