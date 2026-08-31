---
title: 'A reconfigure is not an outage: a generation is a stream plus a fold, and the canonical pointer moves when one is ready'
slug: a-reconfigure-is-not-an-outage
taskedAfter: [appending-to-the-stream-costs-the-batch]
---

> Launch snapshot, records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

> **REPLACES the two-generation design.** An earlier generation of this spec held exactly TWO generations
> in ONE stream, distinguished by a `live`/`staging` label in the key, promoted by relabelling. It is
> superseded, not amended, and the history is in git rather than in this file. Two reasons, both
> decisive: the label is two-valued by construction, so N generations and rollback were NOT reachable
> without redesign (the old spec claimed otherwise and was wrong); and the shared-keyspace promotion
> machinery accounted for six of the ten blocking defects four review rounds found, regenerating a new
> one each time it was fixed. Separate streams delete that machinery outright.
>
> Background, invariants established by reading the code, and the options weighed:
> `work/notes/ideas/stream-grafting-what-we-established.md`. The promotion-cost spike
> (`work/notes/findings/promotion-cost-of-a-two-label-stream.md`) answered a question this design no
> longer asks; it is retained as evidence, not as an input.

## Problem Statement

An indexer has exactly one state, and reconfiguring mutates it in place. When ADR-0034 says a change
"discards the state and re-indexes from block 0", it means the running indexer has nothing to answer
with until it has caught up. In a browser that is a blank app. On a server it is an outage
proportional to the history. The operator's only lever is to not reconfigure.

ADR-0033 and ADR-0034 shrank how OFTEN this happens. They did not change what happens when it does.

There is no way back, either. A processor change that makes the state WORSE is not revertible: the
old state was discarded to build the new one, so the only recovery is another full re-index.

## Solution

**A GENERATION is a stream plus a fold over it.** An indexer holds any number of generations; one is
CANONICAL and answers every read. Reconfiguring builds a new generation alongside the live one and moves
the canonical pointer when it is ready. A generation that is no longer canonical is kept until it is
deleted, so moving the pointer BACK is how you revert.

The whole design rests on splitting one identity into two, which is ADR-0034's distinction made
structural:

- **A STREAM is identified by its FETCH FILTER.** What was requested from the node: chain, addresses,
  topics, ranges. Streams are separate keyspaces, self-contained, and never share entries.
- **A GENERATION is identified by its stream plus its PROCESSOR and CONFIG.** What the fold means.

That split is the reason this is simpler than what it replaces. The most common reconfigure by far is
a processor change, and a processor change does not touch the filter — so it makes a **new generation on
the EXISTING stream** and re-fetches NOTHING. Only a genuine filter change makes a new stream, and
that is the rare case: in production an ABI's topic set changes rarely, and in development the history
is small enough that a re-fetch is cheap.

So the expensive path is rare, the common path is free, and neither needs a graft point, a shared
prefix, a promotion journal or a two-writer rule.

**And the expensive path does not have to be a backfill at all.** A new stream may be SEEDED from a
remote captured stream, or a new generation bootstrapped from a state snapshot, instead of re-fetching
from the node. That is not an optimisation, it is what makes the browser case possible at all — see
below.

## User Stories

1. As a browser user, I want the app to keep rendering while a new generation builds, instead of going
   blank, and to switch when it is ready.
2. As a developer, I want to change the processor without re-fetching a single log, because the
   filter did not move.
3. As a developer, I want to change the source and have the old generation keep answering until the new
   one has caught up.
4. As a developer whose new processor is WORSE, I want to move the canonical pointer back to the
   previous generation, without re-indexing.
5. As a developer, I want to know that a non-canonical generation exists and how far it has caught up,
   so I decide whether to render, dim or hide, since only I know whether my reconfigure made the old
   answers wrong or merely incomplete.
6. As a reader holding a state handle across a pointer move ON THE ENTITIES PATH, I want it to keep
   answering from whichever generation is now canonical, so holding a reference is never a way to be
   silently stale.
7. As a developer, I want a reconfigure the invalidation verdict calls a no-op to cost nothing.
8. As an operator, I want a bound on how many generations and streams a project can accumulate, and a
   loud refusal when I reach it rather than a silent eviction of something I still wanted.
9. As an operator, I want deleting a generation or a stream to be one cheap, complete operation.
10. As an operator, I want to PAUSE a generation so it stops indexing without being deleted, and resume
    it later, without it ever answering with state a reorg has invalidated underneath it.
11. As an operator running MULTIPLE PROJECTS on one server or CLI, I want them fully isolated, so no
    query, prefix scan or cap in one project can ever reach another's data.
12. As a developer, I want a generation whose stream is unavailable to fall back to a full re-index,
    which is today's behaviour, so the feature degrades rather than breaks.
13. As a DEVELOPER iterating on a processor, I want the new generation to become canonical
    IMMEDIATELY, before it has caught up, because I am looking for what my edit does and stale-but-
    complete old answers are more confusing than incomplete new ones.
14. As an APP AUTHOR shipping to users, I want the opposite default — the old generation keeps
    answering until the new one is ready — because my users did not ask for a reconfigure and should
    not see the state go backwards.

## Implementation Decisions

### Identity, and the two levels

**A stream's identity is a digest of its CANONICAL FILTER ENTRY SET.** `eventRanges.ts` already
computes, per source entry, a `streamHash` covering "what the FETCH FILTER is built from, and nothing
else" (address, `topic0`, block range), and already sorts the entries into a canonical set so that
reordering an ABI produces the same bytes. The stream key digests that sorted set. Nothing new is
derived; an existing per-entry digest is rolled up.

**A generation's identity is its stream plus the `processor` version hash plus the config hash.** A
changed processor makes a new generation on the same stream. A changed filter makes a new stream, and
therefore necessarily a new generation.

**Whether a reconfigure creates anything at all is still the VERDICT, not digest equality.**
`sourceInvalidationOf` deliberately ignores an added entry whose `startBlock` is above `lastToBlock`,
so appending an event above the cursor is FREE today, and digest inequality alone would regress
exactly the case ADR-0034 made free. So: the verdict decides whether anything is invalid; the digests
decide WHICH stream and WHICH generation the result belongs to. Both, at different jobs.

**The hash is WIDE and SYNCHRONOUS, and is not `simple_hash`.** As a change DETECTOR a collision
costs one missed invalidation; as a KEY it means one generation silently adopting another's stream, under
a filter that does not match it, so logs are missing and nothing reports it. `simple_hash` is 32 bits
(`(hash << 5) - hash + char`, masked to 32), which is a coin-flip collision around 65,000 distinct
filters. Use a **128-bit synchronous** digest.

Not sha-256, deliberately: the browser's only built-in is `crypto.subtle.digest`, which is ASYNC and
requires a SECURE CONTEXT, so an app served over plain HTTP would fail to derive a key at all. This is
a collision-resistance problem against accidental collisions, not an adversarial one, so the secure
context buys nothing and costs a deployment constraint.

### The stream

**Streams are separate keyspaces and share nothing.** `<project>/<chainId>/<filterDigest>`, with
segments beneath, per `appending-to-the-stream-costs-the-batch`. Two generations on one stream READ it;
only the one that is indexing WRITES it.

**The project is a separate KEY COMPONENT, never mixed into the digest.** Same isolation either way,
but keeping it separate leaves the keys debuggable, lets a project be enumerated or dropped by prefix,
and does not foreclose a future shared stream pool across projects. Hashing it in would make that a
rewrite.

**The CURSOR is ONE record per stream, written ATOMICALLY with the segment it describes.** It is not
copied into every segment. That matters more than it looks: `LastSync.unconfirmedBlocks` is
`EventBlock[]`, and `EventBlock` carries the FULL decoded events of each block (deliberately, since
retraction needs them), so a per-segment copy duplicates up to `finality` blocks of real event data
into every sealed segment, permanently, where it is never read again.

Atomicity is available on two substrates and reachable on the third:

- **IndexedDB**: `setMany` opens ONE `readwrite` transaction, puts every entry and awaits
  `store.transaction`. Segment and cursor commit together.
- **RemoteSQL**: `batch`. ADR-0008 already commits a state chunk and a cursor this way.
- **The filesystem** has no multi-file transaction, so the cursor is the COMMIT POINT instead: write
  the segment file, then write the cursor by temp-file plus `rename`, which IS atomic for one file.
  A crash before the cursor lands leaves it BEHIND, and the segment above it is an ORPHAN of an
  interrupted save, discarded on load. The cursor can never be AHEAD, because it is written last.

Cursor-ahead is the unacceptable failure: it silently skips events that were never stored.
Cursor-behind is recoverable, and discarding orphans above the cursor is what makes it so — the same
shape as the contiguity rule, which clears from the gap upward and keeps the prefix.

**The cursor record carries the whole `LastSync`, exactly as the blob does today** — no published
type changes here, and that is what keeps `appending-to-the-stream-costs-the-batch` a no-published-type
spec. What changes is that there is ONE copy instead of one per segment.

**Its `unconfirmedBlocks` is dead weight in the stream, and that is CHECKED, not assumed.** Three
readers were traced end to end:

- `_feed` is handed the stream's `lastSync` on the state-discarded/stream-kept path, but reads only
  `latestBlock`, `lastToBlock` and `lastFromBlock` from it. The window is rebuilt by
  `generateStreamToAppend` from the IN-MEMORY `lastSync` plus the events being fed.
- `checkTxInclusion` answers from the STATE keeper's copy.
- A full stream replay reconstructs the window as a by-product of the fold, since
  `generateStreamToAppend` derives it from the events it is given.

So the window is never read back OUT of the stream as events, and it does not need to be: it is
derivable from the events the stream already holds, by the replay that already happens.

**`the-stream-stores-only-what-the-node-said` therefore STRIPS it, and this spec must not contradict
that.** That sibling makes the stream raw-only and removes the decoded events from the stored
`LastSync` for exactly this reason — they are the one stale thing left in the stream. This spec's
cursor record is the thing it strips; the two compose rather than conflict.

**The one durable copy that matters is the STATE keeper's**, which is where `checkTxInclusion` reads
and where a normal load resumes from. The window can never be REFETCHED (after a reorg the old blocks
are unreachable, so the node returns the new chain, which is precisely what a reorg check needs to
compare against), but it does not need to be, because it is derivable from stored events and is
already held where it is read.

### Generations

**Any number, bounded by two independent caps, and a cap REFUSES.**

- `maxStreams` per project bounds distinct filters.
- `maxGenerations` per project, as a TOTAL and not per-stream. Per-stream would let total growth scale
  with stream count, leaving the resource anyone actually cares about — total storage, total state
  stores — unbounded.

**The DEFAULTS differ by runtime, because the reason to RETAIN a generation differs.** On a server or
the CLI an operator inspects, A/B-tests and reverts, so retention is the point and the cap should be
generous. In a BROWSER there is usually nothing to revert TO that matters: the app author ships a new
build, and the user did not choose the reconfigure. So the browser default keeps the previous
generation only until the new one is promoted, then drops it — which is two generations transiently,
not N, and bounds browser storage to roughly what it is today rather than to a multiple of it.

**But drop-on-promotion is UNSAFE under the `immediate` policy, and the two knobs must be read
together.** `immediate` promotes a generation that has caught up to NOTHING, so dropping the previous
one at that moment discards a complete state in favour of an empty one, with nothing to fall back to
when the new processor throws on its first event — the exact situation a developer iterating on a
handler is in constantly. So: drop-on-promotion applies to `on-catch-up` and `manual`, where
promotion means the successor DEMONSTRATED something. Under `immediate` the previous generation is
retained until the new one reaches the cursor the old one had at promotion, and only then dropped.

**The cap is a CONFIGURED number and must never be derived from `navigator.storage.estimate()`**, on
three measured grounds (`work/notes/findings/browser-storage-headroom-for-generations.md`): WebKit
does not implement it at all, `quota` varies four-fold between engines and moves between runs on one
engine, and with a real quota forced down to 8 MB it still reported 6.45 GB of headroom while writes
were failing. A pre-flight check against that number is worse than no check.

Two measurements that make the browser default comfortable rather than tight: IndexedDB COMPRESSES
event payloads about 6–10x, so a generation of 31,332 real logs occupies roughly 2 MB stored rather
than the 17.7 MB its JSON weighs; and a `QuotaExceededError` does NOT tear a `setMany`, so the atomic
segment-plus-cursor commit survives a full disk and needs no storage-side guard.

Reaching either cap REFUSES the new generation and names what to delete. It never evicts: eviction picks
a victim by a policy that cannot know which generation an operator was keeping deliberately, and story 4
exists precisely because old generations have value. A refusal costs one operator action; a wrong
eviction costs a re-index.

**Deleting a generation is dropping its state store; deleting a stream is dropping its keyspace.** This
is cheap only because streams are self-contained, which is the payoff of separating them. A stream is
reaped when its last generation goes.

**One CANONICAL POINTER per project names the generation that answers reads.** Moving it IS the
promotion, and it is a single small record write, so promotion has no meaningful cost and no
multi-key recovery problem. Moving it back is the revert.

**The promotion policy has THREE values, not two, because the browser is two different runtimes
wearing one name.** The axis is DEVELOPMENT versus PRODUCTION, and it is not the same axis as
browser-versus-server:

- **`immediate`** — the new generation becomes canonical the moment it is created, before it has
  caught up. `checkTxInclusion` degrades HONESTLY here rather than lying, and this was CHECKED
  against the code rather than assumed: it is answered from the canonical generation's
  `unconfirmedBlocks`, and a generation still catching up has `lastToBlock < latestBlock - finality`,
  which `verdictFor` already answers `unknown` / `window-not-covering` — not `absent`. A generation
  with no `lastSync` at all answers `unknown` / `not-synced`. So a freshly-promoted generation reports
  that it does not know, which is the answer an app can act on safely; it never claims a transaction
  is missing when a neighbouring generation has indexed it. Nothing to build here, and nothing to
  guard against. The DEVELOPMENT default. A developer who just edited a handler is looking for what the
  edit does, and stale-but-complete answers from the old processor are more confusing than incomplete
  answers from the new one. This is closest to today's behaviour, minus the discard: the old
  generation is still there and still reverted-to.
- **`on-catch-up`** — the pointer moves when the new generation reaches the old one's cursor. The
  PRODUCTION default, and the one story 1 asks for.
- **`manual`** — the pointer moves only when asked, so an operator can inspect first.

`immediate` is the value an earlier two-valued knob could not express, and leaving it out would have
forced every developer into either a wait they did not want or a hand-promotion after every save.

**Reads do NOT carry generation identity, and the handle FOLLOWS the pointer.** Per-read provenance
would break the four `StateStore` verbs, four backends and the conformance suite, and is REJECTED.
The entities path publishes a handle bound to a store, so a consumer holding one across a pointer move
would silently read a retired generation; the handle is therefore INDIRECT, resolving to whichever
generation is canonical.

### Seeding is SPLIT OUT, and why

A new stream may be SEEDED from a published artifact instead of backfilled from the node, and for a
user-facing browser app that is the PRIMARY path rather than a fallback: on a public node the
backfill is frequently IMPOSSIBLE, because old logs are not served at all (Base's public endpoints
are the worked example, and it is why stratagems ships a remotely-computed snapshot rather than
indexing from genesis in the browser).

**That is a real requirement and it is NOT taskable yet**, which is why it is
`work/specs/proposed/a-generation-can-be-seeded-from-a-published-artifact.md` rather than a story
here. Two things it needs do not exist: a loader that fetches a captured stream from a REMOTE (today
`loadStreamFixture` reads a local path, and only the state snapshot has a remote path), and a decision
about the publishing side, which is `work/notes/ideas/publishing-snapshots-of-versioned-state.md`
territory. Tasking a confident subset of a spec whose remainder is gated is exactly what
`TASKING-PROTOCOL` §2a forbids, so it splits.

What THIS spec owes that one is only that creating a generation takes its starting stream as an
INPUT: a generation does not assume it must fetch its own history. Nothing else here depends on
seeding.

### Indexing, pausing, and the promotion policy

**A non-canonical generation may INDEX, or be PAUSED, by configuration.** Indexing costs a duplicated
head-following fetch; pausing costs nothing and falls behind.

**PAUSING CAPS the generation's `toBlock` and lets it DRAIN to a final state. It truncates nothing
and reverts nothing.** Pause sets `maxToBlock = x` (the generation's current `lastToBlock`); the
generation keeps polling, fetching nothing above `x` but still re-scanning the reorg window up to it,
until `x` falls below `latestBlock - finality`. At that point every block it holds is FINAL and it is
genuinely idle.

The hazard this addresses is real: a generation that simply STOPS carries an UNCONFIRMED window it
can no longer correct, so if one of those blocks is reorged away it never finds out and its state
permanently contains events from blocks that no longer exist. Draining removes the hazard by waiting
it out instead of by cutting it off.

**It needs no new mechanism, which is the strongest argument for it.** With `toBlock` capped at `x`
and `lastToBlock = x`, the EXISTING `getFromBlock` (`max(min(lastToBlock + 1, latestBlock - finality),
0)`) does the whole thing:

- while `latestBlock - finality <= x`, it returns `latestBlock - finality`, so each round re-scans
  `[latestBlock - finality, x]` — a shrinking window, correcting any reorg that touches what the
  generation holds;
- once `latestBlock - finality > x`, it returns `x + 1`, which is ABOVE the capped `toBlock`, so the
  indexer takes its existing `fromBlock > toBlock` "no new block" branch and fetches nothing.

So a paused generation self-terminates into a no-op poll. Be precise about one thing rather than
overclaiming it: `unconfirmedBlocks` may still LIST blocks, because the re-add rule compares against
`lastToBlock` rather than `latestBlock` and `lastToBlock` is frozen. That is cosmetic. Every block it
lists is below `latestBlock - finality` and therefore final, so nothing it describes can be
invalidated, and nothing re-fetches to compare against it.

**This is why stories 4 and 10 do not conflict.** A truncating pause would have made them
contradictory: story 4 wants the pointer moved BACK to restore a generation's answers EXACTLY, while
a truncating pause changes those answers. Draining preserves them completely — a paused generation
answers precisely what it answered at pause, minus nothing — so a retired generation can be both
paused and faithfully revertible.

Three consequences to build deliberately: pause is not INSTANT, it takes up to `finality` blocks of
continued light polling (head checks plus a shrinking re-scan) before the generation is idle, and a
consumer should be able to see that draining state; `revertTo` is NOT needed on this path, which
matters because it is destructive and capability-gated; and resume is simply removing the cap.

### Multi-project

**The project discriminator is structural, never a field a query can omit.** This repo has already
been bitten by exactly this class: `stream_tag_1` is a prefix of `stream_tag_10_0`, so a bare prefix
filter silently crossed CHAINS. A project discriminator has the identical failure mode with a larger
blast radius. Every read and write takes a composite key that carries it; there is no default project
and no way to address storage without one.

**Whether that maps to one shared table with a discriminator column, a table prefix, or a schema per
project is a STORAGE ADAPTER decision, not a model decision** — and it stays that way only if the key
is composite. Sharing a table is cheap in storage and performance; what it is not cheap in is safety,
and the composite key is what buys the safety back.

**Streams are PER PROJECT to start.** Two projects watching the same contracts could share one stream
and one fetch, which is a real multi-tenant saving, but it reintroduces the multi-referent lifetime
problem that killed share-by-reference in this design's own history: whose stream is it, who may
delete it, does one project's reconfigure disturb another's. Per-project duplicates some fetching and
keeps every lifetime trivial. The key shape above leaves the global pool reachable later.

### Relationship to ADR-0008

ADR-0008 (`processor-upgrades-rebuild-blue-green-from-the-stored-stream`) already decided this shape
for the server: rebuild from the locally stored stream into a new namespace keyed by the PROCESSOR
VERSION HASH, keep serving the old, flip a `current_version` pointer, drop the old. This spec is the
same mechanism generalised, and it should be read as extending that ADR rather than competing with it.

Three differences to record, because they are real:

- ADR-0008 keys the new namespace by the PROCESSOR VERSION HASH alone. Here a generation is keyed by
  stream plus processor plus config, so a filter change is a different stream rather than a different
  namespace over the same one. ADR-0008's keying cannot express that case.
- ADR-0008 feeds both namespaces for a short window and then flips. Here the pointer flip is the only
  step, because the generations are independent and neither needs the other quiesced.
- ADR-0008 says retention is load-bearing, since a rebuild needs the stream from genesis. That holds
  and is why the caps REFUSE rather than evict.

`an-ingest-server-reconfigure-is-not-a-blackout` currently lists "does the server hold two
generations, or refuse?" as OPEN. ADR-0008 answered it, and this spec answers it. That stub should be
reconciled or dropped rather than left asking a settled question.

## Testing Decisions

- **A processor-only change re-fetches NOTHING**, asserted on the ranges the node was asked for. Zero,
  not fewer. This is the headline: the filter did not move, so the stream is reused whole.
- **A filter change creates a NEW stream**, and the old stream is untouched, byte for byte, while the
  new one backfills.
- **Reads succeed continuously across a reconfigure** and answer from the canonical generation until the
  pointer moves. Assert on the ANSWERS, since reads do not report identity.
- **The pointer moves BACK**: after moving to a new generation, moving the pointer to the previous one
  restores its answers exactly, with no re-indexing and no fetch.
- **A no-op reconfigure creates nothing**, asserted on ranges fetched AND state discarded, the pair
  ADR-0034 established. An event appended above the cursor is the regression guard.
- **The cursor is never AHEAD of its events.** Interrupt a save at the write seam on both keepers; a
  reload must never report coverage the stream does not hold. On the filesystem, assert the orphan
  segment above the cursor is discarded rather than replayed.
- **`unconfirmedBlocks` never appears in a stored segment**, asserted at the storage seam. This is the
  guard against re-introducing the duplication, and it is checkable by inspection.
- **A filter digest collision cannot be produced** by the canonical-set construction across a corpus
  of realistic sources, and the digest is stable under ABI reordering and under a redundant appended
  entry, which the canonical set already normalises away.
- **Two projects with IDENTICAL sources never touch each other's data**: same chain, same contracts,
  same processor; deleting every stream and generation in one leaves the other complete and readable.
  This is the multi-tenancy guard and it fails loudly under any missing discriminator.
- **A cap REFUSES and names what to delete**, and nothing is evicted. Assert the existing generations are
  all still readable after the refusal.
- **Deleting a generation leaves its stream** if another generation uses it, and reaps the stream when the
  last one goes.
- **A paused generation DRAINS to a final state and loses nothing.** Assert: after pause its
  `toBlock` is capped; it keeps re-scanning the shrinking window and corrects a reorg that strikes at
  or below the cap; once the cap falls below `latestBlock - finality` it fetches nothing (the
  existing `fromBlock > toBlock` branch); and its answers at that point are EXACTLY what they were at
  pause. That last one is the guard that keeps story 10 compatible with story 4, which a truncating
  pause would have broken.
- **A paused generation is revertible-to**: move the pointer to it and assert it answers precisely
  what it answered before, with no re-index and no fetch.
- **A paused generation resumes correctly**: resume is removing the cap, and a reorg that struck
  BELOW the cap while it was draining was already corrected; one that struck above it is re-derived
  on the first uncapped round, since `getFromBlock` re-scans from `latestBlock - finality`.
- **A handle held across a pointer move** keeps answering, from the newly canonical generation.
- **A generation's progress is visible** while it is behind, and stops being reported once canonical.
- **Round-trip through BOTH keepers**, since they are independent implementations of one contract.

## Tasking note

SIX separable landables. Cutting them together produces one task nobody can review.

1. **Stream identity and the keyspace** — the canonical filter digest, the wide sync hash, the
   `<project>/<chainId>/<filterDigest>` key, and the composite key type that makes the project
   discriminator non-omittable. Owns the hash choice and its collision test. Everything depends on it.

   **It also OWNS the migration off the prerequisite's keyspace, which is otherwise unowned and would
   silently orphan every cached history.** `appending-to-the-stream-costs-the-batch` leaves users
   holding `stream_<name>_<chainId>_<ordinal>` plus its cursor record (and, for anyone older, the
   adopted label-less legacy key). This spec's key matches NONE of those, so landed in the stated
   order every existing stream becomes unreachable AND is never deleted: a full re-index plus a
   permanent storage leak, which directly reverts the prerequisite's story 5. The existing stream is
   ADOPTED at its computed `<project>/<chainId>/<filterDigest>` — the filter it was fetched under is
   the one the running source describes, or the adoption is refused and the old keys are swept rather
   than left. Migrate by RENAME, which the spike showed moves no payload; order each write before its
   delete so a crash leaves both and the migration re-runs harmlessly.
2. **The generation registry, the canonical pointer, and the caps** — creating a generation, moving the
   pointer (forward and back), refusing at a cap, deleting a generation or a stream. Independently
   testable with no indexer running.
3. **The verdict becomes a published, actionable answer.** `sourceInvalidationOf` is INTERNAL
   (`packages/core/src/index.ts` re-exports only `ReorgCause`/`ReorgDetection` from that module, and
   core's `exports` map is `.` plus `./package.json`), and `updateIndexer` computes the verdict then
   discards it — the code says the block "is carried no further than the log line". The container is
   browser-side, so the verdict must cross that boundary. ADDITIVE: it publishes the verdict and grows
   `ReconfigureOutcome` while the verbs still discard as they do today; landable 4 removes the
   discard when it lands the container that replaces it. Includes the `stateDiscarded` sweep, **38**
   references — `packages/core` (11), `packages/browser` (23), `examples/browser-reference` (2),
   `docs/guide/indexing-in-a-browser-app/index.md` (2).
4. **The container plus the factory migration.** The indirect handle, per-generation state factories,
   and passing the processor factory rather than its result. This landable also DISCHARGES
   `work/notes/observations/keepstate-storage-id-omits-the-processor-version.md`: that observation
   reports the js-object keeper deriving its storage key without the processor version, so two
   generations collide on one key. A generation's identity here is stream plus processor plus config,
   and the container supplies it, which is exactly the fix — assert the non-collision and delete the
   note. BREAKING and mostly mechanical: **37 call
   sites** outside `dist/`, of which **31 under `packages/browser/test/`** (`dispose` 3,
   `invalidation` 2, `liveReload` 8, `processorKinds` 10, `reconfigure` 2, `setupIndexing` 2,
   `txInclusion` 4), plus `packages/browser/browser/workload.ts`, plus **FIVE** example apps
   (`web-demo`, `event-processor-nfts`, `browser-reference`, `basic`, `mud`). Four further edit sites
   are unowned unless named: the README usage block, two JSDoc examples in
   `packages/browser/src/IndexerState.ts`, the JSDoc in `BrowserStateStore.ts`, and `CONTEXT.md`.
5. **Pause and resume**, including the truncation and the matching state revert.
6. **Progress and degradation** — `SyncingState` reporting that a non-canonical generation exists and
   how far it has caught up (story 5), and the fallback when a generation's stream is unavailable or
   unreadable: a full re-index, which is today's behaviour, so the feature degrades rather than
   breaks (story 12). Small, but it was unowned, and story 12 is the guard that stops a corrupt
   stream taking the app down with it.

Landables 3, 4, 5 and 6 all edit `packages/browser/src/IndexerState.ts` (`SyncingState` at the top,
`createIndexerState`, three `stateDiscarded` sites, and the container is what it returns), so
serialise them with `blockedBy`. A workable order is (1) and (2), then (3), then (4), then (5), then (6).

## Out of Scope

- **Sharing a prefix between two streams.** The named, deliberately-declined optimisation: when a new
  filter is a superset of an old one, the new stream is identical to the old up to some point and
  could reuse it.

  **If it is ever built, it makes a REMOVABLE thing PERMANENT, and that cost must be counted at the
  time.** `appending-to-the-stream-costs-the-batch` keeps a prefix on a gap rather than clearing, and
  isolates that recovery so it can be dropped later; the SCANNED EXTENT a sealed segment carries
  exists solely to enable it and is required to have exactly one reader. Prefix sharing wants that
  same extent for a second purpose, which would make both it and the recovery load-bearing forever.
  Note also that it is not as cheap as it sounds: identity is enumeration over an ANCHORED key
  pattern, so a segment lives under one stream's prefix only, and a superset filter yields a
  DIFFERENT digest — so reuse needs an indirection, which is the head pointer that spec rejected on
  merit. Worth doing later, and cheap to add because streams are addressed by digest and
  nothing about this design assumes a stream was fetched entirely by its own generation. Not now: it
  buys a rare case and it is where all the complexity of the superseded design lived.
- **Sharing streams ACROSS projects.** Reachable; see the multi-project decision for why not first.
- **Pruning segments WITHIN a stream.** Not needed: the bound is the caps plus explicit deletion.
- **Exposing which generation answered a read.** Purely additive later; a query layer is its home.
- **Smoothing the pointer move.** It is a step. Interpolating would serve a state neither generation had.

## Further Notes

**The unit is a GENERATION, and the word was chosen by elimination.** `version` is taken twice over —
an entity row's half-open block-validity range (`CONTEXT.md`), and a processor's `version` field,
which is an INPUT to a generation's identity here rather than the thing itself, so the same word
would mean two things one sentence apart. `deployment` is worse (it already means the fetcher/server
topology and a browser installation, both a level ABOVE this). `candidate` is taken by the entity
snapshot path. `generation` had zero prior uses in `CONTEXT.md`, `packages/*/src` or `docs/adr/`, and
is pinned in the `CONTEXT.md` glossary alongside `stream`, `project` and `canonical pointer`.

The design record `work/notes/ideas/stream-grafting-what-we-established.md` carries the invariants
this rests on and the options weighed, including the two-generation design this replaces.
