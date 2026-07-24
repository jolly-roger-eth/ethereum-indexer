---
title: Evaluate replacing the hand-rolled createAction with an async-control library
slug: replace-createaction-with-a-library
---

## The opportunity

The core `EthereumIndexer` serializes its overlapping operations (`_index` / `_feed` / `_load` / `_save`) through a bespoke primitive, `createAction` (in `packages/ethereum-indexer/src/internal/utils/promises.ts`), built on a custom `createCancellablePromise`. It offers `queue` / `ifNotExecuting` / `now` / `once` / `cancel` / `block` semantics plus a context slot.

Per ADR discussion this was **organic growth**, not a deliberate "no-dependencies" decision — no library evaluation was done at the time. So it is a candidate refactor, NOT an architectural decision (hence an idea, not an ADR).

## What to evaluate

Is there a small, well-maintained async-control library that covers what `createAction` actually needs — crucially **cooperative cancellation** (the `unlessCancelled` thread) and the run-modes (drop-if-running vs. queue vs. run-once) — without pulling in a heavy dependency? Candidates to weigh (verify current status/fit before trusting): p-queue / p-limit (queueing/concurrency, but cancellation story is limited), AbortController-based patterns (native cancellation), XState (a state machine — heavier, but the load/feed/index lifecycle is arguably a state machine), or a small mutex/`async-mutex`.

Key constraints any replacement must satisfy:

- **Cancellation must be cooperative and reach in-flight awaits** (today via `unlessCancelled`), because a reconfigure/reset needs to abort an in-progress index/feed cleanly.
- **EIP-1193 / browser-friendly**, zero or tiny footprint (this runs in-browser — see ADR 0002).
- Preserve the exact run-mode semantics the indexer relies on (e.g. `indexMore` = ifNotExecuting; `feed` = queue-next; `load` = once).

## Why it's worth a look

`createAction` + `createCancellablePromise` is subtle, hand-rolled concurrency with no tests of its own beyond the indexer's usage — the kind of code where a bug is costly and a battle-tested library could reduce risk. But only if a library genuinely fits the cancellation model; otherwise keep it. Deletion test first: would a library actually concentrate this complexity, or just move it?
