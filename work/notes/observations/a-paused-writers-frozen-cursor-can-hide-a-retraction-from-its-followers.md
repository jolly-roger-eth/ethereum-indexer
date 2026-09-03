# A paused writer's frozen cursor can hide a drain-time retraction from its followers

2026-09-03, noticed while building `a-generation-pauses-by-cap-and-drain` (out of its scope: the fix is on the FOLLOW path, which is `a-non-canonical-generation-advances-on-a-shared-stream`'s surface).

`IndexerGeneration.promiseToFollow` decides there is something to follow by comparing the STORED stream cursor's `lastToBlock` against its own (`if (lastSyncStored.lastToBlock <= current.lastToBlock) return current;`). A PAUSED writer's `lastToBlock` is frozen at its cap, so a reorg it detects and appends to the stream *during its drain* leaves that cursor unmoved — and a follower level with the cap therefore takes the early return and never replays the retraction, keeping events from a dead branch. Not reachable before pause landed, because a running writer's `lastToBlock` rises with the tip on every cycle.

Same guard, same shape as the reason `Indexer.pause` refuses a follower outright (`CannotPauseFollowerError`, ADR-0045): a follower's advance is driven by a cursor rather than by what the stream now says.
