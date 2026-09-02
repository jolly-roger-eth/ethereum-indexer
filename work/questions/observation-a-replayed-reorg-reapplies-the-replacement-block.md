<!-- dorfl-sidecar: item=observation:a-replayed-reorg-reapplies-the-replacement-block type=observation slug=a-replayed-reorg-reapplies-the-replacement-block allAnswered=false -->

Item: [`observation:a-replayed-reorg-reapplies-the-replacement-block`](../notes/observations/a-replayed-reorg-reapplies-the-replacement-block.md)

## Q1

**What should become of this observation? Reply with a disposition and a reason: resolve (settle it, keep the note on record — say why), promote (mint a task / spec / adr — say which and why), delete (redundant or obsolete — say why), or duplicate (maps onto an existing item — name it).**

> The engine records your disposition from the answer (no token needed); an answered promote mints the artifact, resolve keeps the note settled, delete/duplicate discharge it.

<!-- q1 fields: id=q1 -->

**Your answer** (write below this line):

DUPLICATE — maps onto `task:a-rebuild-replays-the-retractions-the-stream-carries` (minted from `observation:a-rebuild-off-a-cached-stream-drops-its-retractions`, which explicitly "sharpens" this note).

Same defect, two views of it. This note recorded the SYMPTOM observed on the free-form path: a replayed reorged stream applies the replacement block twice, producing state derived partly from a dead branch, silently. The other note found the MECHANISM (`promiseToFeed` derives retractions from `lastSync.unconfirmedBlocks` only; a rebuild starts from an empty window, so `groupLogsPerBlock` drops the stored `removed` events and no `revertTo` happens) and caught it as a HARD failure on the entity path, where the store refuses the second block at that height.

Both were reproduced independently of the segmented keeper — this one against a hand-rolled whole-blob `ExistingStream` storing the shipped `lastSync` shape — which is what establishes the defect is engine-side and pre-dates PR #35. That evidence is already carried into the promoted task, along with the severity point this note contributes: where the double-apply is tolerated rather than refused, the result is silently wrong state rather than an error.

Nothing is lost by discharging this one; the task covers it.
