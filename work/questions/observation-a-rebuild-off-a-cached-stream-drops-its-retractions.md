<!-- dorfl-sidecar: item=observation:a-rebuild-off-a-cached-stream-drops-its-retractions type=observation slug=a-rebuild-off-a-cached-stream-drops-its-retractions allAnswered=false -->

Item: [`observation:a-rebuild-off-a-cached-stream-drops-its-retractions`](../notes/observations/a-rebuild-off-a-cached-stream-drops-its-retractions.md)

## Q1

**What should become of this observation? Reply with a disposition and a reason: resolve (settle it, keep the note on record — say why), promote (mint a task / spec / adr — say which and why), delete (redundant or obsolete — say why), or duplicate (maps onto an existing item — name it).**

> The engine records your disposition from the answer (no token needed); an answered promote mints the artifact, resolve keeps the note settled, delete/duplicate discharge it.

<!-- q1 fields: id=q1 -->

**Your answer** (write below this line):

PROMOTE — mint a TASK. This is a live correctness bug in the engine, not a note to settle: a rebuild off a cached stream silently discards the retractions the stream carries, so a reorged history is replayed as if both branches were live.

Why a task and not a spec or an ADR: the desired behaviour is already settled and needs no new design. A replay must reproduce the same sequence of applies and reverts that the live path produced. What is missing is the mechanism, and it is a bug in an existing seam rather than a new capability.

The mechanism is already diagnosed in the note and should be carried into the task: `EthereumIndexer.promiseToFeed` derives retractions from `this.lastSync.unconfirmedBlocks` ONLY, and `groupLogsPerBlock` (`packages/core/src/internal/engine/utils.ts`) skips `removed` events out of what it is handed. A rebuild starts from `freshLastSync`, whose window is empty, so a stored stream containing a reorg replays with its retractions dropped: `generateStreamToAppend` emits both branches as live blocks and no `revertTo` happens.

Scope it to the ENGINE (`packages/core`). It is NOT the stream keeper's bug: the note reproduced it against a hand-rolled whole-blob `ExistingStream` storing the full `lastSync` (the SHIPPED shape), so it pre-dates the segmented keeper that landed in PR #35 and must not be "fixed" by making the keeper store a window again — that would undo a deliberate decision (the window has two homes that ARE read; the stream's copy is read by nobody).

There is already a characterization test pinning the current wrong behaviour: `packages/browser/test/streamSegments.test.ts`, "is REFUSED on a rebuild, because the replay drops the stored retractions". It asserts the entity store's refusal (`block 104 is already recorded`). That test MUST be inverted as part of the fix rather than deleted — it is the regression proof, and it is the reason this is provable rather than argued.

Also fold in `observation:a-replayed-reorg-reapplies-the-replacement-block`, which recorded the SYMPTOM of this same defect on the free-form path (the replacement block applied twice, silently wrong state rather than a hard failure). One task covers both; that note is the duplicate.

Severity worth stating in the task: on the entity path it is a hard failure (the store refuses the second block at that height), but on any path that tolerates the double-apply it is SILENTLY WRONG STATE derived partly from a dead branch.
