# Processor upgrades rebuild blue-green from the stored stream

When the processor's logic changes but the stream does not (same contracts, same events), the state must be discarded and recomputed, and the old state must keep being served until the new one is ready. The rebuild replays the **locally stored** emission stream into a **new state namespace** keyed by the processor version hash, chunk by chunk, while live indexing continues to write and serve the old namespace. Once the rebuild reaches the stream head, both namespaces are fed for a short window, then a single `current_version` pointer row is flipped atomically and the old namespace is dropped. We chose blue-green because a rebuild takes arbitrarily long and readers must never see partial state.

## Considered Options for driving the replay

A serverless worker cannot run a rebuild as a loop, so it must be chunked against a durable checkpoint and re-invoked:

- **Self-enqueueing via a queue (chosen).** Process a chunk sized to a CPU and statement budget, commit the state chunk and the rebuild cursor in one `batch`, then enqueue "continue from X" to itself. Near-immediate re-invocation, so it runs at full speed as a sequence of short invocations.
- **Cron-driven.** Cloudflare's one-minute minimum granularity makes a multi-million-block rebuild impractical on its own. **Kept as a watchdog**: a tick that restarts a rebuild whose checkpoint has not advanced, so a lost queue message cannot strand a migration.
- **Piggyback on the fetcher's pushes.** Rebuild speed capped at chain speed. Useless for history.
- **External driver** (CLI or container). Works, but adds a second runtime to operate.
- Cloudflare **Workflows** is a legitimate managed alternative to the hand-rolled queue loop. The design should name it without depending on it.

## Consequences

- The rebuild is a **local sequential scan**, not a re-fetch from the chain or across the wire, which is a direct benefit of the stream living next to the state (ADR-0003, ADR-0006).
- The double-write window between catch-up and the pointer flip is short and cheap; rollback before the flip is free.
- **Retention becomes load-bearing.** A rebuild needs the stream from genesis, so pruning the stream is what makes processor upgrades impossible. This is the main argument for pair-compaction being off by default.
- **`getVersionHash` becomes load-bearing in a way it was not.** It is author-maintained today, and the processor's construction-time configuration is not part of it (`docs/reviews/server-cli-batch.md`, HIGH-2 and MEDIUM-3). Previously a missed bump meant reusing a stale snapshot. Now it means the rebuild **never triggers**, so state computed by logic that has already been replaced is served indefinitely, with no cold start to rescue it. Deriving that hash from the processor bundle itself, rather than trusting an author-maintained string, is a requirement of this design and not a follow-up.
