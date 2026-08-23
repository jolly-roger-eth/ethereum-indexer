---
title: The patch-based light store behind the seam, advertising revert-only
slug: light-store-behind-the-seam
spec: one-processor-everywhere
blockedBy: [portable-mutation-context-seam, retention-capability-and-refusal]
covers: [6, 9]
---

## What to build

The lightest legitimate implementation of the seam: state held as a plain object, history held as immer reverse patches, reorg revert by replaying those patches backwards. It exists so that the cheapest deployment (a browser tab that only needs current state and reorg safety) pays nothing for versioned rows, while running the SAME processor as the server.

**It advertises `revert-only`, and that is a measured result rather than a limitation to apologise for.** The mechanism is CORRECT wherever the patches still exist: `work/notes/findings/sqlite-in-the-browser.md` replayed backwards on a dense stream and matched the recorded state at every depth to 64, on Chromium, Firefox, WebKit and node, at a cost linear in depth. But history is pruned by BLOCK-NUMBER distance (`tipBlockNumber - blockNumber > finality`), while a real stream carries only event-bearing blocks, which on the real launched stratagems game are median 429 blocks apart. At a finality of 64, exactly ONE block's reversals survive: the tip's. So on a real sparse contract there is nothing to replay, and the capability is withdrawn by SPARSITY, not by cost. No tuning returns it.

Concretely, that means: `revertTo` works and is the reason this backend exists; every as-of read is refused with the typed error from `retention-capability-and-refusal`; and the capability report says `revert-only` rather than a window. The one thing this backend must NEVER do is answer a historical read from the tip, which is exactly what a caller would get today from a store that has no concept of history.

Two details worth encoding rather than leaving to be rediscovered. The patch log's SIZE follows the same sparsity fact: 1,702 KB (223% of the state) on a dense synthetic stream, 4.4 KB (1% of the state) on the real one, because almost everything is pruned immediately. And where a light backend does answer, cost is linear in DEPTH, so 126 ms at depth 64 on a laptop is roughly half a second on a mid-range device profile.

Note what this is NOT. It is not the incumbent `keepStateOnIndexedDB`, which serialises the whole state blob on every save; that is a PERSISTENCE strategy, and it is measured as the fastest writer at today's sizes (2.0 ms/block on Chromium) precisely because it does no history at all. This backend keeps the free-form-object ergonomics of the light path while sitting behind the declared-entity seam, so the same processor runs on it. How its state is persisted (or whether it is persisted at all) is a decision this task must make and record; it may legitimately be memory-only.

## Acceptance criteria

- [ ] A processor written once runs unchanged on this backend and on the SQLite store, producing equal state on the same input.
- [ ] The backend reports `revert-only`, and the conformance suite's capability cases pass against it.
- [ ] `revertTo` reverses correctly to the finality depth, including the counter-must-decrease case, on a stream whose event-bearing blocks are FAR APART (not a dense synthetic one). This is the case the design exists for and the one a dense fixture would fail to exercise.
- [ ] Every as-of read is refused with the typed refusal error. There is no code path by which a historical read returns the tip value.
- [ ] The id-prefix listing works on this backend as a sorted walk, with read-your-writes inside the block, once `bounded-id-prefix-listing` has landed. (If it has not, say so and leave a failing-by-declaration gap rather than a silent one.)
- [ ] Whether and how state is persisted is an explicit decision, recorded; if it is memory-only, the capability report and the documentation say so rather than leaving a user to discover it on reload.
- [ ] Tests in the package's `test/`, vitest, plus a changeset.

## Blocked by

- `portable-mutation-context-seam`: the seam and the backend interface.
- `retention-capability-and-refusal`: the typed refusal this backend returns for every historical read, and the `revert-only` capability kind.

## Prompt

> Build the patch-based light store behind the processor storage seam in the `etherfold` monorepo: state as a plain object, history as immer reverse patches, reorg revert by backwards replay.
>
> FIRST, check this task against current reality: read `work/specs/proposed/one-processor-everywhere.md` (or `work/specs/tasked/`), confirm `portable-mutation-context-seam` and `retention-capability-and-refusal` landed as assumed. Read ADR-0001 (reorg revert via immer reverse patches), the existing `@etherfold/js-processor` and its `History`, and `packages/js-processor/test/reorg.test.ts`.
>
> The vocabulary: a REVERSE PATCH is what immer produces alongside a change and is what undoes it; FINALITY DEPTH bounds how far back reversals are kept; `revert-only` is a declared retention capability meaning the backend can undo a reorg but cannot answer a historical read; a BLOCK ADDRESS is a hash, a height or a timestamp.
>
> The decisive measured fact, from `work/notes/findings/sqlite-in-the-browser.md`, and the reason this backend advertises `revert-only` rather than a window: history is pruned by BLOCK-NUMBER distance from the tip, while a real stream carries only event-bearing blocks, which on the real launched stratagems game are median 429 blocks apart. At a finality of 64, exactly one block's reversals survive. Backwards replay is CORRECT wherever the patches exist (verified at every depth to 64 on four runtimes), so this is not a bug to fix; it is the honest capability. Do not be tempted by the fact that a dense synthetic stream makes as-of reads look available. Test on a SPARSE stream.
>
> Never answer a historical read from the tip. That is the single failure mode this design exists to prevent, and it is worse than an error because it is plausible.
>
> Done means: the same processor that runs on the SQLite store runs here, reorg revert is correct on a sparse stream including a counter that decreases, and every historical read is a typed refusal.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your final report, in particular the persistence choice (including memory-only, if that is what you choose) and its consequence on reload.
