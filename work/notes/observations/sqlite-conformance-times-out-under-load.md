---
title: 'The sqlite conformance suite times out against vitest 5s default when the machine is loaded'
slug: sqlite-conformance-times-out-under-load
observed: 2026-08-28
source: 'noticed while driving task:an-event-is-never-silently-dropped-from-the-fetch-filter, whose full `pnpm test` reddened on four of these with nothing else failing'
---

Four cases in `packages/state-store-sqlite/test/conformance.test.ts` failed with
`Error: Test timed out in 5000ms.` during a full `pnpm test` (that file reported `218868ms`
for 273 tests); re-run alone the same file passes all 273 in 3.17s. Same shape as
`bigint-digest-sweep-flakes-the-gate`: wall-clock, not logic, and it reds the acceptance
gate for whatever unrelated task is building.
