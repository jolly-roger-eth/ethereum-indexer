---
'@etherfold/browser': patch
---

Fix: a reconfigure that rebuilt its state from a CACHED STREAM no longer reports that state as empty.

The re-seed added alongside `ReconfigureOutcome` assumed a discard always leaves nothing to publish. It does not. When a kept stream is still valid -- which a processor swap always leaves it, since `indexerMatches` compares the source and the config and not the processor -- `load` REPLAYS the cached events and publishes the rebuilt state before the reconfigure returns. The re-seed then ran and overwrote it with the processor's empty initial state.

So the one case the stream cache exists for (re-index without re-fetching) reported a correct rebuild to every subscriber as an empty state, with the cursor already advanced past the blocks, so nothing arrived later to correct it.

The hook now re-seeds only when the core published no state during the call. Both directions are pinned: a discard with nothing to replay still blanks, and a discard that replayed a cached stream keeps what the replay produced, without going back to the node for history it already had.
