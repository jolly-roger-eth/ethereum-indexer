---
title: 'Pair-compaction reclaims a retracted entry with its retraction, in blocks, off by default'
slug: pair-compaction-is-off-by-default
spec: indexer-server-feed
blockedBy: [a-consumer-follows-the-seq-ordered-stream-from-a-validated-opaque-cursor]
covers: [7]
---

## What to build

Let an operator reclaim the noise a reorg leaves in the stored stream: a retracted entry dropped
TOGETHER WITH its retraction, far below finality, deliberately and never by accident.

### The depth, and why it is shaped like retention

Two decisions already made in this repo settle this, and they are followed rather than re-derived.

- **The unit is BLOCK NUMBERS and no other unit, with the finality depth as the FLOOR** (ADR-0019).
  A duration prunes on the wrong clock: an indexer stalled for a day would drop a day of history it
  never finished writing, and a halted chain would expire its window while its tip stands still. A
  configured depth that would compact at or above `latestBlock - finality` is REFUSED at the API, not
  clamped, exactly as retention refuses durations rather than discouraging them.
- **Compaction is a call the HOST SCHEDULES, not a side-effect of an append** (ADR-0022). The cost is
  proportional to what it drops, so doing it on the write path would put a stall onto whichever batch
  happened to cross a threshold, for work that batch did not cause. It deletes a bounded set per call
  rather than by an open predicate, so one request never carries unbounded work. And a browser tab, a
  backfilling CLI and a long-running server want three different cadences; the store must not choose
  one for them.

So the configuration declares the WINDOW and defaults to off, and a separate host-scheduled verb does
the work. Off-by-default then falls out of nobody calling it.

### Why this is safe, which is the property to preserve

Pair-compaction is **answer-preserving for the canonical view by construction**: it only ever removes
rows that are already `alive = false`, which that view already excludes. No gated read can change.
The only consumer that can observe it is one following the `seq` stream further behind than finality,
and that consumer is already outside the window it may rely on.

## What this is NOT

- **NOT deleting a retraction without its entry, or an entry without its retraction.** Half a pair
  would show a retraction for something absent, or a retracted entry as live.
- **NOT on by default, and NOT automatic.** No cadence is invented here.
- **NOT compaction inside the finality window.** A retraction can still arrive there.
- **NOT a renumbering of `seq`.** Compaction leaves HOLES, which is legal and which the feed cursor
  already tolerates.

## Acceptance criteria

- [ ] A retracted entry and its retraction are removed TOGETHER, and only when both are below the
      configured depth. Asserted on the rows.
- [ ] It is OFF by default: a deployment that configures nothing compacts nothing, asserted.
- [ ] A configured depth that would compact at or above `latestBlock - finality` is REFUSED at the
      API rather than clamped, with the refusal naming the finality floor.
- [ ] A unit other than block numbers is refused at the API.
- [ ] Compaction happens only when the host calls it: appending a batch never compacts, asserted.
- [ ] One call performs BOUNDED work rather than deleting by an open predicate.
- [ ] **The canonical view returns byte-identical answers before and after a compaction**, over the
      same gate. This is the property the whole design rests on.
- [ ] A `seq`-stream consumer follows the stream across the resulting HOLES with nothing skipped and
      no stall.
- [ ] Ship a changeset for every published package whose surface changes.
- [ ] `pnpm build && pnpm typecheck && pnpm test` green.

## Blocked by

- `a-consumer-follows-the-seq-ordered-stream-from-a-validated-opaque-cursor` must land first, because
  compaction is what CREATES holes in `seq` and that task is where a cursor learns to tolerate them.
  Shipping this first would put holes into a stream nothing yet reads across.

## Prompt

> Add optional PAIR-COMPACTION to the server's stored emission stream: a retracted entry dropped
> together with its retraction, far below finality, off by default.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does
> it still match the code, `work/tasks/done/` and the ADRs (0006 on the stored stream and compaction
> being off by default, 0019 on retention being block numbers with finality as the floor, 0022 on
> pruning being a host-scheduled call)? If a premise no longer holds, route to needs-attention.
>
> The depth is NOT a new kind of knob. Follow the two decisions this repo already made. The unit is
> BLOCK NUMBERS and nothing else, because a duration prunes on the wrong clock: a stalled indexer
> would drop history it never finished writing and a halted chain would expire its window while its
> tip stands still. The finality depth is the FLOOR, and a configured value that would compact at or
> above `latestBlock - finality` is REFUSED at the API rather than clamped, the same way retention
> refuses a duration outright.
>
> And it is a call the HOST SCHEDULES, not something an append does on its way past. The cost is
> proportional to what it drops, so putting it in the write path stalls whichever batch crossed a
> threshold for work that batch did not cause, and it would have the store pick a cadence on behalf of
> a browser tab, a backfilling CLI and a long-running server, which want three different ones. One
> call does BOUNDED work.
>
> Keep the safety property explicit while building, because it is why this can exist at all:
> pair-compaction only ever removes rows that are already not alive, which the canonical view already
> excludes, so it is ANSWER-PRESERVING for that view by construction. Prove it in a test rather than
> asserting it in a comment. The only observer is a `seq`-stream consumer lagging further behind than
> finality, which is already outside the window it may rely on.
>
> Never drop half a pair, never renumber `seq`, and never compact inside the finality window where a
> retraction can still arrive. The holes compaction leaves are legal, and the feed cursor already
> tolerates them.
>
> Done means: pairs go together and only below the depth, nothing compacts unless a host asks, a too-
> shallow depth is refused with the floor named, the canonical view answers identically before and
> after, and a consumer follows the holes without stalling.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT, in
> particular the bound on one call's work and where the configuration lives.

## Decisions

**Where the configuration lives: an argument to the verb, resolved by an exported `resolvePairCompaction`, and NOT a field on `IndexerRegistryEntry` or `ServerOptions`.** A field on the registry entry would be config this package reads nowhere, since nothing in the server calls the verb (nothing may: the cadence is the host's, ADR-0022). So the deployment holds the setting where it holds its other deployment config, validates it at startup with `resolvePairCompaction` (so a bad depth is a boot failure, not a 3am surprise from a scheduler), and passes it to `compactEmissionPairs`. The verb resolves again internally, so the finality floor cannot be bypassed by handing it a window nobody checked. Alternatives considered: a `compaction` field on `IndexerRegistryEntry` (rejected: dead config, and it would need `finality` on `LogIngestion` to enforce the floor, widening a core interface for a feature that is off); an admin route (rejected: a new user-visible surface and a second place off-by-default could be got wrong). **Touches:** `IndexerRegistryEntry` stays as it was; no CLI flag was added either (see below).

**No `--compaction` CLI flag.** `--retention` exists on the CLI because retention bounds READS from the moment it is set even if nothing prunes; a compaction depth changes nothing at all until a host calls the verb, so a flag would be a knob that does nothing on every command the CLI has today. Alternative: add the flag now and leave it unwired (rejected: an operator setting it would reasonably believe compaction was happening). **Touches:** `packages/cli` config, if a scheduled maintenance verb is ever added there.

**The bound on one call's work: `maxPairs`, defaulting to 490, with the scan bounded at `maxPairs * 2` rows.** One call reads at most `maxPairs * 2` candidate rows and deletes at most `maxPairs` pairs, named row by row (never `DELETE ... WHERE`, per ADR-0022, since a hosted backend caps rows written per request and `remote-sql` reports no affected-row count). `PAIRS_PER_STATEMENT = 49` makes a delete statement carry exactly 100 bound parameters (2 discriminators + 2×49 `seq`s), which is D1's cap, and 490 is ten such statements: one SELECT plus ten DELETEs fits the FREE D1 plan's 50 queries per invocation with room to spare. `complete` reports whether the scan reached the end, so an amortised policy and a whole sweep are both expressible without the store inventing a cadence. Alternative considered: prune's shape (unset budget = loop until done), rejected because a compaction call that can grow unboundedly is exactly what a serverless host cannot schedule. **Touches:** a future `d1CompactionBudget`-style helper in `platforms/cf-worker` if a Worker ever schedules this.

**A depth exactly AT the finality depth is legal, and compaction is strictly BELOW `latestBlock - depth`.** The criterion says a depth that would compact *at or above* `latestBlock - finality` is refused. Making the deletion strictly below the floor means `depth === finality` touches nothing at or above `latestBlock - finality`, so the floor is a legal value rather than the first illegal one, which is exactly how `resolveRetention` treats `blocks < finalityDepth`. One rule, spelled the same way in both places. Alternative: refuse `depth <= finality`, rejected because it would make retention and compaction disagree about what "the floor" means by one block.

**The candidate scan is ordered by `(blockNumber, logIndex, blockHash, seq)` and not by `seq`, and no index is added for it.** Block order puts the two rows of a pair adjacent, so pairing is local to the page and a budget can never cut between an entry and its retraction; `seq` order (the primary key, the cheaper scan) would leave a small budget reading a page of entries whose retractions all sit just past the end, making no progress. Neither order rides an index anyway, because the only relevant index is PARTIAL on `alive = 1`, so a scan over dead rows is a table scan either way. I deliberately did not add a third index to `EmissionStream`: it would be paid for by every deployment, on a table already weighed against D1's 10GB ceiling, to serve a feature that is off by default. **Touches:** the schema (unchanged, still version 2) and `node-log-api`'s index budget, if compaction is ever scheduled hot enough to want one.

**`latestBlock` is supplied by the host, not read from the table.** The highest block the table carries a log at is the highest *event-bearing* block (median 429 blocks behind on the real measured stream), so measuring the depth from it would silently mean something other than what an operator configured. A non-integer or negative tip is refused rather than compacted against.

**Recorded, not decided: pair-compaction is observable on the canonical view's fork search too.** `forkBlockSince` finds a fork by looking for retraction rows above a cursor's mark, so a reorg whose pair has been reclaimed can no longer be named. That needs a consumer holding a cursor minted before a reorg and presenting it only after that reorg fell below the configured depth, i.e. lagging further behind than finality, which is the same observer ADR-0006 already accepts and is why the finality depth is the floor. Documented at both sites and asserted the other way round (a consumer inside the window still gets its rewind after a compaction). No ADR: ADR-0006, ADR-0019 and ADR-0022 already carry the substance, and these are follow-through rather than new decisions.
