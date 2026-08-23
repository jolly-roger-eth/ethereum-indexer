---
title: 'An as-of read with a non-numeric `at` answers `undefined` rather than raising'
slug: as-of-read-does-not-check-its-block-number
observed: 2026-08-23
source: 'task:query-surface-from-entity-declarations, while pinning that a hash cannot reach a store with no addressing layer'
---

`MemoryStateStore.getAsOf('token', {id: '1'}, {hash: '0x64'} as never)` returns `undefined`: `assertRetained` passes on an unbounded store, and the version predicate then compares an object against block numbers, matching nothing (`packages/state-store/src/memory.ts`). The same shape reaches the patch and IndexedDB backends, which also type `at` as a number and do not check it. It is only reachable from JavaScript or through a cast, since the types say `number`, but the answer it produces is an ordinary "the entity was absent then" rather than the refusal this seam gives everywhere else a read cannot be served.

Not fixed here (the generated read surface refuses it at compile time instead). Recorded because a run-time guard would belong at the seam, next to `assertRetained`, and would cover every backend at once.
