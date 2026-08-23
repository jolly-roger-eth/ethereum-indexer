---
title: '`VersionedStateView` (what `process()` hands back) exposes no bounded listing'
slug: versioned-state-view-has-no-listing
observed: 2026-08-23
source: 'task:query-surface-from-entity-declarations, while checking how a consumer reads state today'
---

`packages/processor-sqlite/src/view.ts` forwards `getCurrent` / `getAsOf` / `queryCurrent` / `queryAsOf` / `getBlock` / `resolveBlockNumber`, but not `listCurrent` / `listAsOf`, so a consumer holding the read handle a `VersionedStateEventProcessor.process()` returns cannot use the bounded id-prefix listing that `bounded-id-prefix-listing` added to every backend (it can reach the same rows through `queryCurrent` with a hand-written `WHERE`, which is the surface the listing exists to avoid needing).

Not touched here: this task's generated read surface is built over `StateStore` and has the listing on both tiers, so nothing is blocked. Recorded because the untyped handle is what the published package hands out today.
