---
title: 'A reconfigure is not an outage: a version is a stream plus a fold, and the canonical pointer moves when one is ready'
slug: a-reconfigure-is-not-an-outage
taskedAfter: [appending-to-the-stream-costs-the-batch]
---

> Launch snapshot, records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

> **REPLACES the two-generation design.** An earlier version of this spec held exactly TWO generations
> in ONE stream, distinguished by a `live`/`staging` label in the key, promoted by relabelling. It is
> superseded, not amended, and the history is in git rather than in this file. Two reasons, both
> decisive: the label is two-valued by construction, so N versions and rollback were NOT reachable
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

**A VERSION is a stream plus a fold over it.** An indexer holds any number of versions; one is
CANONICAL and answers every read. Reconfiguring builds a new version alongside the live one and moves
the canonical pointer when it is ready. A version that is no longer canonical is kept until it is
deleted, so moving the pointer BACK is how you revert.

The whole design rests on splitting one identity into two, which is ADR-0034's distinction made
structural:

- **A STREAM is identified by its FETCH FILTER.** What was requested from the node: chain, addresses,
  topics, ranges. Streams are separate keyspaces, self-contained, and never share entries.
- **A VERSION is identified by its stream plus its PROCESSOR and CONFIG.** What the fold means.

That split is the reason this is simpler than what it replaces. The most common reconfigure by far is
a processor change, and a processor change does not touch the filter — so it makes a **new version on
the EXISTING stream** and re-fetches NOTHING. Only a genuine filter change makes a new stream, and
that is the rare case: in production an ABI's topic set changes rarely, and in development the history
is small enough that a re-fetch is cheap.

So the expensive path is rare, the common path is free, and neither needs a graft point, a shared
prefix, a promotion journal or a two-writer rule.

## User Stories

1. As a browser user, I want the app to keep rendering while a new version builds, instead of going
   blank, and to switch when it is ready.
2. As a developer, I want to change the processor without re-fetching a single log, because the
   filter did not move.
3. As a developer, I want to change the source and have the old version keep answering until the new
   one has caught up.
4. As a developer whose new processor is WORSE, I want to move the canonical pointer back to the
   previous version, without re-indexing.
5. As a developer, I want to know that a non-canonical version exists and how far it has caught up,
   so I decide whether to render, dim or hide, since only I know whether my reconfigure made the old
   answers wrong or merely incomplete.
6. As a reader holding a state handle across a pointer move ON THE ENTITIES PATH, I want it to keep
   answering from whichever version is now canonical, so holding a reference is never a way to be
   silently stale.
7. As a developer, I want a reconfigure the invalidation verdict calls a no-op to cost nothing.
8. As an operator, I want a bound on how many versions and streams a project can accumulate, and a
   loud refusal when I reach it rather than a silent eviction of something I still wanted.
9. As an operator, I want deleting a version or a stream to be one cheap, complete operation.
10. As an operator, I want to PAUSE a version so it stops indexing without being deleted, and resume
    it later, without it ever answering with state a reorg has invalidated underneath it.
11. As an operator running MULTIPLE PROJECTS on one server or CLI, I want them fully isolated, so no
    query, prefix scan or cap in one project can ever reach another's data.
12. As a developer, I want a version whose stream is unavailable to fall back to a full re-index,
    which is today's behaviour, so the feature degrades rather than breaks.

## Implementation Decisions

### Identity, and the two levels

**A stream's identity is a digest of its CANONICAL FILTER ENTRY SET.** `eventRanges.ts` already
computes, per source entry, a `streamHash` covering "what the FETCH FILTER is built from, and nothing
else" (address, `topic0`, block range), and already sorts the entries into a canonical set so that
reordering an ABI produces the same bytes. The stream key digests that sorted set. Nothing new is
derived; an existing per-entry digest is rolled up.

**A version's identity is its stream plus the `processor` version hash plus the config hash.** A
changed processor makes a new version on the same stream. A changed filter makes a new stream, and
therefore necessarily a new version.

**Whether a reconfigure creates anything at all is still the VERDICT, not digest equality.**
`sourceInvalidationOf` deliberately ignores an added entry whose `startBlock` is above `lastToBlock`,
so appending an event above the cursor is FREE today, and digest inequality alone would regress
exactly the case ADR-0034 made free. So: the verdict decides whether anything is invalid; the digests
decide WHICH stream and WHICH version the result belongs to. Both, at different jobs.

**The hash is WIDE and SYNCHRONOUS, and is not `simple_hash`.** As a change DETECTOR a collision
costs one missed invalidation; as a KEY it means one version silently adopting another's stream, under
a filter that does not match it, so logs are missing and nothing reports it. `simple_hash` is 32 bits
(`(hash << 5) - hash + char`, masked to 32), which is a coin-flip collision around 65,000 distinct
filters. Use a **128-bit synchronous** digest.

Not sha-256, deliberately: the browser's only built-in is `crypto.subtle.digest`, which is ASYNC and
requires a SECURE CONTEXT, so an app served over plain HTTP would fail to derive a key at all. This is
a collision-resistance problem against accidental collisions, not an adversarial one, so the secure
context buys nothing and costs a deployment constraint.

### The stream

**Streams are separate keyspaces and share nothing.** `<project>/<chainId>/<filterDigest>`, with
segments beneath, per `appending-to-the-stream-costs-the-batch`. Two versions on one stream READ it;
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

**`unconfirmedBlocks` is NOT in the stream at all.** It is state, and the state already persists it:
the entities path serialises the whole `LastSync` as the opaque cursor string (ADR-0027,
`processor-entities/src/cursor.ts`, which exists because that window carries BigInt-bearing events).
So on a normal load the window comes from the state, and on a rebuild it falls out of the replay as a
by-product of the fold. It is never a separate reconstruction.

It must NEVER be refetched from the node, and the reason is not cost: after a reorg the old blocks are
unreachable, so the node returns the NEW chain, which is precisely what a reorg check needs to compare
AGAINST. Refetching cannot answer the question it would be asked.

### Versions

**Any number, bounded by two independent caps, and a cap REFUSES.**

- `maxStreams` per project bounds distinct filters.
- `maxVersions` per project, as a TOTAL and not per-stream. Per-stream would let total growth scale
  with stream count, leaving the resource anyone actually cares about — total storage, total state
  stores — unbounded.

Reaching either cap REFUSES the new version and names what to delete. It never evicts: eviction picks
a victim by a policy that cannot know which version an operator was keeping deliberately, and story 4
exists precisely because old versions have value. A refusal costs one operator action; a wrong
eviction costs a re-index.

**Deleting a version is dropping its state store; deleting a stream is dropping its keyspace.** This
is cheap only because streams are self-contained, which is the payoff of separating them. A stream is
reaped when its last version goes.

**One CANONICAL POINTER per project names the version that answers reads.** Moving it IS the
promotion, and it is a single small record write, so promotion has no meaningful cost and no
multi-key recovery problem. Moving it back is the revert.

**Reads do NOT carry version identity, and the handle FOLLOWS the pointer.** Per-read provenance
would break the four `StateStore` verbs, four backends and the conformance suite, and is REJECTED.
The entities path publishes a handle bound to a store, so a consumer holding one across a pointer move
would silently read a retired version; the handle is therefore INDIRECT, resolving to whichever
version is canonical.

**A non-canonical version may INDEX, or be PAUSED, by configuration.** Indexing costs a duplicated
head-following fetch; pausing costs nothing and falls behind.

**PAUSING TRUNCATES the version to a segment boundary below the finality horizon, and reverts its
state to match.** This is what makes a paused version safe to keep serving from. A stopped indexer
otherwise carries an UNCONFIRMED window it can no longer correct: if one of those blocks is reorged
away it never finds out, and its state permanently contains events from blocks that no longer exist.
Truncating removes exactly the part that could be wrong.

Three consequences to build deliberately: truncate to a SEGMENT BOUNDARY rather than rewriting a
sealed segment; revert the STATE to the same point, or the state is ahead of its stream; and resume
needs no special validation, because `getFromBlock` re-scans from `lastToBlock - finality` on the
first round anyway.

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
for the server: rebuild from the locally stored stream into a new namespace keyed by the processor
version hash, keep serving the old, flip a `current_version` pointer, drop the old. This spec is the
same mechanism generalised, and it should be read as extending that ADR rather than competing with it.

Three differences to record, because they are real:

- ADR-0008 keys the new namespace by the PROCESSOR VERSION HASH alone. Here a version is keyed by
  stream plus processor plus config, so a filter change is a different stream rather than a different
  namespace over the same one. ADR-0008's keying cannot express that case.
- ADR-0008 feeds both namespaces for a short window and then flips. Here the pointer flip is the only
  step, because the versions are independent and neither needs the other quiesced.
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
- **Reads succeed continuously across a reconfigure** and answer from the canonical version until the
  pointer moves. Assert on the ANSWERS, since reads do not report identity.
- **The pointer moves BACK**: after moving to a new version, moving the pointer to the previous one
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
  same processor; deleting every stream and version in one leaves the other complete and readable.
  This is the multi-tenancy guard and it fails loudly under any missing discriminator.
- **A cap REFUSES and names what to delete**, and nothing is evicted. Assert the existing versions are
  all still readable after the refusal.
- **Deleting a version leaves its stream** if another version uses it, and reaps the stream when the
  last one goes.
- **A paused version is truncated below the finality horizon and its state reverted to match**, so its
  answers contain nothing a reorg could invalidate. Assert the state cursor and the stream cursor
  agree after a pause.
- **A paused version resumes correctly** across a reorg that happened while it was paused, deriving it
  from the node on its first round rather than inheriting a stale window.
- **A handle held across a pointer move** keeps answering, from the newly canonical version.
- **A version's progress is visible** while it is behind, and stops being reported once canonical.
- **Round-trip through BOTH keepers**, since they are independent implementations of one contract.

## Tasking note

Five separable landables. Cutting them together produces one task nobody can review.

1. **Stream identity and the keyspace** — the canonical filter digest, the wide sync hash, the
   `<project>/<chainId>/<filterDigest>` key, and the composite key type that makes the project
   discriminator non-omittable. Owns the hash choice and its collision test. Everything depends on it.
2. **The version registry, the canonical pointer, and the caps** — creating a version, moving the
   pointer (forward and back), refusing at a cap, deleting a version or a stream. Independently
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
4. **The container plus the factory migration.** The indirect handle, per-version state factories, and
   passing the processor factory rather than its result. BREAKING and mostly mechanical: **37 call
   sites** outside `dist/`, of which **31 under `packages/browser/test/`** (`dispose` 3,
   `invalidation` 2, `liveReload` 8, `processorKinds` 10, `reconfigure` 2, `setupIndexing` 2,
   `txInclusion` 4), plus `packages/browser/browser/workload.ts`, plus **FIVE** example apps
   (`web-demo`, `event-processor-nfts`, `browser-reference`, `basic`, `mud`). Four further edit sites
   are unowned unless named: the README usage block, two JSDoc examples in
   `packages/browser/src/IndexerState.ts`, the JSDoc in `BrowserStateStore.ts`, and `CONTEXT.md`.
5. **Pause and resume**, including the truncation and the matching state revert.

Landables 3, 4 and 5 all edit `packages/browser/src/IndexerState.ts` (`SyncingState` at the top,
`createIndexerState`, three `stateDiscarded` sites, and the container is what it returns), so
serialise them with `blockedBy`. A workable order is (1) and (2), then (3), then (4), then (5).

## Out of Scope

- **Sharing a prefix between two streams.** The named, deliberately-declined optimisation: when a new
  filter is a superset of an old one, the new stream is identical to the old up to some point and
  could reuse it. Worth doing later, and cheap to add because streams are addressed by digest and
  nothing about this design assumes a stream was fetched entirely by its own version. Not now: it
  buys a rare case and it is where all the complexity of the superseded design lived.
- **Sharing streams ACROSS projects.** Reachable; see the multi-project decision for why not first.
- **Pruning segments WITHIN a stream.** Not needed: the bound is the caps plus explicit deletion.
- **Exposing which version answered a read.** Purely additive later; a query layer is its home.
- **Smoothing the pointer move.** It is a step. Interpolating would serve a state neither version had.

## Further Notes

The word **version** is used here in its ordinary sense and COLLIDES with two existing uses that a
reader must keep separate: an entity row's half-open block-validity range (`CONTEXT.md`), and a
processor's `version` field, which is an INPUT to a version's identity here rather than the thing
itself. If that proves confusing in review, `generation` remains unused in `CONTEXT.md`,
`packages/*/src` and `docs/adr/`, and is the fallback. `deployment` and `candidate` are both taken.

The design record `work/notes/ideas/stream-grafting-what-we-established.md` carries the invariants
this rests on and the options weighed, including the two-generation design this replaces.
