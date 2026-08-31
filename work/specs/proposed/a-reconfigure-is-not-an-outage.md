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
8. As an operator, I want a bound on how many generations and streams an indexer can accumulate, and a
   loud refusal when I reach it rather than a silent eviction of something I still wanted.
9. As an operator, I want deleting a generation or a stream to be one cheap, complete operation.
10. As an operator, I want to PAUSE a generation so it stops indexing without being deleted, and resume
    it later, without it ever answering with state a reorg has invalidated underneath it.
11. As a developer, I want a stream to be RESOLVED by its filter, so two generations with different
    filters never collide and one with the same filter is reused.
    (Multi-tenancy across several NAMED INDEXERS is `the-server-and-cli-hold-generations-too`; a
    browser page carries one indexer and needs no discriminator beyond the `name` it already has.)
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

**A stream's identity is a digest of its DEDUPLICATED `streamHash` VALUES, SORTED BY `streamHash`.**
Say it that precisely, because the obvious phrasing is wrong in a way that silently breaks this
spec's headline case. `eventRanges.ts` computes, per source entry, a `streamHash` covering "what the
FETCH FILTER is built from, and nothing else" (address, `topic0`, block range), and sorts the entry
list by `(startBlock, hash)`. That sort key is **`hash`, not `streamHash`** — and `hash` covers the
DECODING shape. So a decode-only change (a renamed non-indexed parameter, the very case the
two-digest split exists for) REORDERS the list while every `streamHash` in it is unchanged. A digest
rolled up over the list in that order would move, fork a new stream key, re-fetch the whole history
and orphan the old stream — silently, with no error — which is the exact opposite of what this spec
promises for a decode-only change.

So: take the `streamHash` values only, DEDUPLICATE them, sort them BY THEMSELVES, and digest that.
`hash` and `legacyHash` are excluded; digesting whole entries has the same defect, worse.

**The stream digest ALSO covers the STREAM CONFIG hash, and ADR-0006 already said so.** The filter is
not the only thing that decides what a stream CONTAINS. `ProvidedStreamConfig` is `{finality,
alwaysFetchTimestamps, alwaysFetchTransactions, parse}`, and `alwaysFetchTimestamps`,
`alwaysFetchTransactions` and `parse.filters` each change WHAT IS STORED.

**One third of that justification is DELETED WITH THE KNOB, and the conclusion is unaffected.**
`the-stream-stores-only-what-the-node-said` DELETES `logValues` outright (it is an unused stub whose
only purpose, reducing what is stored, that spec removes). So `logValues` stops being a reason to
fork a stream by ceasing to exist, rather than by becoming a reason that is quietly wrong. Nothing
here needs narrowing and no follow-up decision is left open: `alwaysFetchTimestamps` and
`alwaysFetchTransactions` still change what is stored, and `parse` remains in the hash on the
strength of `parseConfig.filters`, which narrows which events are parsed and kept at all. The config
hash keeps its full justification.

Keyed on the filter alone, two different configs would map to ONE stream, so a generation would adopt
logs the verdict has already declared invalid, and the only existing remedy (clear the stream) would
destroy the stream the live generation is still answering from, which story 3 forbids.

**This is a correction, not an innovation: ADR-0006 keys the stored stream by `{source, config}` and
the state by `{source, config, processor}`.** This spec's stream digest is the concrete form of that
ADR's `{source, config}`, narrowed on the source side to the FETCH half of the source per ADR-0034.
Record the narrowing where ADR-0008's differences are recorded; do not silently re-key a stream ADR-0006
governs.

**A generation's identity is its stream plus the `processor` version hash.** Config is already inside
the stream digest, so naming it again here would be redundant. A
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
requires a SECURE CONTEXT, so an app served over plain HTTP would fail to derive a key at all
(`localhost` IS a secure context, so this bites non-localhost plain HTTP specifically). This is
a collision-resistance problem against accidental collisions, not an adversarial one, so the secure
context buys nothing and costs a deployment constraint.

### The stream

**Streams are separate keyspaces and share nothing.** The prerequisite already addresses a stream
HIERARCHICALLY as `[<indexer-name>, <streamDigest>, <ordinal>]` and leaves the digest level as a
PLACEHOLDER; this spec fills it with the real value. So there is no re-keying and no migration: the
address shape does not change, only what occupies one level of it. A server holds several named
indexers over the same shape — see the sibling spec. `chainId` is deliberately absent throughout,
being already inside the digest. Two generations on one stream READ it;
only the one that is indexing WRITES it.

**There is NO tenancy component in the browser key, because a browser page carries exactly ONE
indexer.** An earlier draft put a discriminator in the key here and asserted it was the existing
caller-supplied `name` renamed. That was wrong on the code: `createIndexerState` takes NO name —
`keepState` and `keepStream` are separate optional options each closing over their OWN name, an
entities deployment passes no `keepState` at all and discriminates by `databaseName` (which
DEFAULTS), and the CLI keeper takes only a folder. There is no single name at the indexer level to
promote.

More to the point, the browser does not need one. A page carries one indexer; where two unrelated
indexers share an origin, the EXISTING `name` and `databaseName` already separate them, and that
mechanism is untouched here.

**So multi-tenancy is a SERVER and CLI concern, and it lives in
`the-server-and-cli-hold-generations-too`** — including the composite key whose discriminator is
structurally non-omittable, which is a real requirement on a runtime that genuinely holds several
named indexers. That spec also answers where the name comes from (it arrives on `upload`), which the
browser never has to.

**The CURSOR is the PREREQUISITE's business, not this spec's.**
`appending-to-the-stream-costs-the-batch` fixes a CURSOR CONTRACT of four properties — exactly one
authoritative cursor per stream; a save never leaves a cursor claiming coverage the stored events
lack; no unconfirmed WINDOW on a sealed segment; an empty save costing nothing proportional to
history — and leaves PLACEMENT to each keeper. Both shipped keepers put the cursor in the OPEN TAIL
and empty its window on seal; a keeper with atomic multi-row updates may hold a cursor row instead.

**All this spec adds is the SCOPE: one cursor per STREAM, and a stream is now addressed
`[<indexer-name>, <streamDigest>]` with its segments and its cursor beneath.** Everything else about cursors — where they live, how a save
commits, what happens after a crash — is settled there and must not be restated here, because a
second statement is a second source of truth that can drift. An earlier draft of this section
specified a separate cursor record with orphan discard; that design was withdrawn in the prerequisite
after four review rounds found defects in it and nowhere else, and its tasks are already emitted
against the tail strategy.

Two consequences to carry, both of them the prerequisite's rules applied to a generation:

- **A generation's stream is read by both generations and written by one.** The one indexing writes;
  the other reads. That is the existing one-writer situation, not a new rule, because the two
  generations have DIFFERENT stream keys unless they share a filter and config — in which case they
  are the same stream and the non-canonical one is a reader.
- **`unconfirmedBlocks` stays in the TAIL.** Do not strip it here: the prerequisite explicitly forbids
  it, and removing it entirely is `the-stream-stores-only-what-the-node-said`'s job.

### Generations

**Any number, bounded by two independent GENERATION CAPS, and a cap REFUSES.**

Call them CAPS and never "retention". `retention` is already pinned, by `CONTEXT.md` and ADR-0019, to
a distance in BLOCK NUMBERS, with ADR-0019 explicitly refusing a second retention mode measured in
anything else. A generation cap is a COUNT of generations, a different object entirely — and every
generation HAS a store WITH a retention window, so the two words will meet in one config object.

- `maxStreams` per indexer bounds distinct filters.
- `maxGenerations` per indexer, as a TOTAL and not per-stream. Per-stream would let total growth scale
  with stream count, leaving the resource anyone actually cares about — total storage, total state
  stores — unbounded.

**The RETENTION defaults differ by runtime, and unlike the promotion axis this one IS detectable — a
package knows which it is.** On a server or
the CLI an operator inspects, A/B-tests and reverts, so KEEPING generations is the point and the cap
should be generous. In a BROWSER there is usually nothing to revert TO that matters: the app author ships a new
build, and the user did not choose the reconfigure. So the browser default keeps the previous
generation only until the new one is promoted, then drops it — which is two generations transiently,
not N, and bounds browser storage to roughly what it is today rather than to a multiple of it.

**Drop-on-promotion interacts with the promotion POLICY and is resolved there**, under "Drop-on-
promotion is INCOMPATIBLE with `immediate`" below. Stated once, deliberately: this spec's own rule is
that a second statement of a rule is a second source of truth that can drift.

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

**One CANONICAL POINTER per indexer names the generation that answers reads.** Moving it IS the
promotion, and it is a single small record write, so promotion has no meaningful cost and no
multi-key recovery problem. Moving it back is the revert.

**The promotion policy has THREE values, and `on-catch-up` is the default EVERYWHERE.** There is no
per-runtime and no per-environment default, because the axis that would select one is not detectable:
promotion would want a DEVELOPMENT-versus-PRODUCTION distinction, and nothing in a browser build can
tell which it is in. An undetectable axis with a dangerous default is worse than no axis, so the safe
value is the default and the unsafe one is a deliberate opt-in:

- **`on-catch-up`** (DEFAULT, everywhere) — the pointer moves when the new generation reaches the old
  one's cursor. What story 1 asks for.
- **`immediate`** — the new generation becomes canonical the moment it is created, before it has
  caught up. OPT-IN. It is what a developer iterating on a handler wants, because stale-but-complete
  answers from the old processor are more confusing than incomplete answers from the new one; it is
  not something a deployment should ever land in by accident.
- **`manual`** — the pointer moves only when asked, so an operator can inspect first.

`checkTxInclusion` degrades HONESTLY under `immediate`, and this was CHECKED against `verdictFor`
rather than assumed — including which BASIS answers, because the two differ and only one of them was
checked the first time:

- a caller with NO `minedAtBlock` on a generation still catching up (`lastToBlock < latestBlock -
  finality`) gets `unknown` / `window-not-covering`;
- a caller WITH a `minedAtBlock` above the cursor gets `absent` / **`ahead-of-cursor`**, because that
  branch is tested BEFORE the window-not-covering one. The STATUS is `absent`, so the earlier claim
  that a catching-up generation never answers `absent` was wrong on the code.

The SAFETY conclusion survives, on the basis rather than on the status: `ahead-of-cursor` means "not
processed that far yet", which is the correct direction for the caller this exists for — an
optimistic update laid over a generation that has not reached the transaction is right, not
double-counted. What must not be built is a consumer switching on `status` alone, and a test written
from the old sentence would have failed. A generation with no `lastSync` answers `unknown` /
`not-synced`.

**Drop-on-promotion is INCOMPATIBLE with `immediate`, and the two are resolved by ORDER rather than
by an interlock.** `immediate` promotes a generation that has caught up to nothing, so dropping the
previous one at that moment discards a complete state for an empty one with no fallback when the new
processor throws on its first event. So: **drop-on-promotion applies only under `on-catch-up` and
`manual`**, where promotion means the successor demonstrated something. Under `immediate` the
previous generation is retained until the new one reaches the cursor the old one had at promotion,
and only then dropped. Because `immediate` is now opt-in rather than a default, this is a documented
consequence of a deliberate choice instead of a trap the primary runtime falls into.

**Reads do NOT carry generation identity, and the handle FOLLOWS the pointer.** Per-read provenance
would touch the four `StateStore` READ verbs (`getCurrent`, `listCurrent`, `getAsOf`, `listAsOf` —
the interface has eleven in total), four backends and the conformance suite. Note the reason that is
NO LONGER load-bearing: that breadth used to be a COST argument, and it is not, since nothing is
published (`CONTEXT.md`) so the churn is work rather than risk. It is still REJECTED, on the ground
that survives: provenance on every read is noise on the common path, and "which generation answered"
is purely ADDITIVE later where a caller actually needs it (see Out of Scope), so putting it in the
seam now would tax four backends forever to answer a question almost no read asks.
The entities path publishes a handle bound to a store, so a consumer holding one across a pointer move
would silently read a retired generation; the handle is therefore INDIRECT, resolving to whichever
generation is canonical.

**It RE-RESOLVES ONCE PER READ UNIT OF WORK and holds that generation for its duration — and in the
BROWSER that unit is the interval between NOTIFICATIONS.** Name it, because the rule was written for
a server request and this spec's landables are browser-side, so a builder would otherwise have to
invent a boundary. `createIndexerState` already returns subscribable stores (`state`, `syncing`,
`status`) and already pushes updates through the indexer's state callback, so the app already treats
a notification as "the world moved, re-read". **A pointer move is APPLIED AT a notification**, which
makes every read between two notifications answer from ONE generation without inventing a scope API,
a transaction handle or a timer. It also composes with the server tier rather than competing with it:
there the unit is the request, here it is the interval, and the RULE is the same in both.

The residual, stated rather than discovered: a caller that reads OUTSIDE any subscription (a one-off
read in an event handler) gets per-CALL resolution, so two such reads either side of a promotion can
straddle it. Tolerable, and bounded: under the `on-catch-up` default the successor has reached the
canonical cursor so the two answers agree closely, and the case where they differ sharply is
`immediate`, which is opt-in and for a developer watching their own edit.
Indirection without a stated granularity is a new failure rather than a fix: a GraphQL request fans
out into many resolver calls, so a pointer move mid-request would yield a response MIXING TWO
GENERATIONS that no consumer can detect — and under the `immediate` policy the mixture is a COMPLETE
generation and an EMPTY one. That is the plausible-wrong-answer class this repo refuses everywhere
(ADR-0015, ADR-0019, ADR-0028). The query layer this is heading for (Hono/Yoga/Pothos over entity
declarations, guaranteed by `one-processor-everywhere`) is exactly where a read unit of work is
identifiable, so the rule is pinned here for it to consume. Landable 4 owns it.

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

### Multi-tenancy is NOT here

A browser page carries one indexer, so this spec has no tenancy discriminator and needs none: the existing
`name` (and `databaseName` on the entities path) already separates two unrelated indexers sharing an
origin, and nothing here changes that.

The runtime that genuinely holds several NAMED INDEXERS is a server or a CLI, and
`the-server-and-cli-hold-generations-too` owns it — the composite key whose discriminator cannot be
omitted, where its value comes from, and whether it maps to a column, a prefix or a schema. That is
the right home: the discriminator is only load-bearing where more than one tenant exists, and
inventing one here would have made every browser caller supply something it has no use for.

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

**The SERVER side of this generalisation is not this spec.** ADR-0008's 2026-08-31 amendment routes
it to `the-server-and-cli-hold-generations-too`, which owns the stream keeper over the emission-stream
table, the container above `StreamBuilder` that replaces `processor.clear()`, and this ADR's
`current_version` row's successor. This spec is the MODEL and the browser runtime; read the ADR
section above as what the model owes that ADR, not as a claim on the server.

(The stub `an-ingest-server-reconfigure-is-not-a-blackout`, which asked whether the server holds two
generations or refuses, was already DROPPED once this spec and its server sibling answered it. It is
in `work/specs/dropped/`.)

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
- **The cursor contract is the PREREQUISITE's to assert**, not this spec's. Do not restate it here;
  the only thing to assert is the SCOPE, that a cursor belongs to exactly one
  `[<indexer-name>, <streamDigest>]` subtree and two generations on different streams never share one.
- **The stream digest is STABLE UNDER A DECODE-ONLY CHANGE.** This is the assertion that catches the
  ordering trap: rename a non-indexed parameter, and the digest must not move even though every
  entry's `hash` did and the entry list therefore reordered. Also stable under ABI reordering and
  under a redundant appended entry, and a collision cannot be produced across a corpus of realistic
  sources.
- **The stream digest MOVES on a stream-config change**, and the old stream is left intact rather
  than adopted. Use `alwaysFetchTimestamps` or `alwaysFetchTransactions` as the worked example, NOT
  `parse.logValues`, which `the-stream-stores-only-what-the-node-said` deletes. This is the guard
  against a generation adopting logs the verdict has declared invalid.
- **A cap REFUSES and names what to delete**, and nothing is evicted. Assert the existing generations are
  all still readable after the refusal.
- **Deleting a generation leaves its stream** if another generation uses it, and reaps the stream when the
  last one goes.
- **A paused generation DRAINS to a final state and loses nothing.** Assert: after pause its
  `toBlock` is capped; it keeps re-scanning the shrinking window and corrects a reorg that strikes at
  or below the cap; once the cap falls below `latestBlock - finality` it fetches nothing (the
  existing `fromBlock > toBlock` branch); and its answers at that point are EXACTLY what they were at
  pause — asserted in a NO-REORG scenario, because the two halves are mutually exclusive once a reorg
  is corrected. That is the guard that keeps story 10 compatible with story 4, which a truncating
  pause would have broken.
- **A reorg striking at or below the cap while draining IS corrected**, asserted separately: the
  answers then differ from the pause instant, correctly, because they were wrong before.
- **A paused generation is revertible-to**: move the pointer to it and assert it answers precisely
  what it answered before, with no re-index and no fetch.
- **A paused generation resumes correctly**: resume is removing the cap, and a reorg that struck
  BELOW the cap while it was draining was already corrected; one that struck above it is re-derived
  on the first uncapped round, since `getFromBlock` re-scans from `latestBlock - finality`.
- **A handle held across a pointer move** keeps answering, from the newly canonical generation.
- **A generation's progress is visible** while it is behind, and stops being reported once canonical.
- **Round-trip through BOTH keepers**, since they are independent implementations of one contract.

## Tasking note

EIGHT separable landables. Cutting them together produces one task nobody can review.

1. **Stream identity and the keyspace** — the STREAM DIGEST, the wide sync hash, and the
   `[<indexer-name>, <streamDigest>, <ordinal>]` address, filling the digest level the prerequisite
   left as a placeholder. Owns the hash choice and its collision test. Everything depends on it.

   **The digest is the deduplicated `streamHash` digest PLUS the stream config hash, and both halves
   are this landable's.** Say it here and not only in the prose above, because this is where it gets
   BUILT: a landable that read "the filter digest" would key the narrower thing, and two configs
   would then map to one stream, so a generation adopts logs the verdict has already declared
   invalid. There is NO tenancy component and no composite key type here — a browser page carries one
   indexer, no caller supplies such a value, and the server's discriminator belongs to
   `the-server-and-cli-hold-generations-too`.

   **The digest's ENCODING is this landable's**, because the address level has to hold it: it must be
   a value the substrates can carry as a key element (a string on IndexedDB and a directory name on
   the filesystem), so a hex or base32 rendering rather than raw bytes, and fixed-length so no
   rendering of one digest can be confused with another. There is no enumeration PATTERN to own —
   hierarchical addressing means enumeration is a scoped listing of one level — which is what
   deletes the anchored regex, the cross-chain collision hazard and the temp-name constraint an
   earlier flat-key design had to carry.

   **There is NO MIGRATION and no sweep, because the prerequisite already left the level empty.**
   `appending-to-the-stream-costs-the-batch` addresses a stream as
   `[<indexer-name>, <streamDigest>, <ordinal>]` with a PLACEHOLDER in the digest position. This
   landable computes the real digest and writes it there. Streams under the placeholder are simply
   streams under a different digest: they are unreachable by a filter that now resolves elsewhere,
   so they are REAPED by the ordinary stream-reaping rule (landable 2), not by a bespoke migration
   path. That deletes the whole of what this landable used to own here — a resumable per-key payload
   rewrite, its quota exposure, and then even the sweep that replaced it.

   Two things follow that are worth stating so they are not rediscovered:

   - **Nothing needs to move because nothing is addressed by content that changed.** Hierarchical
     addressing is what buys this: with a delimited flat key, changing one component re-keyed every
     segment, which is why earlier drafts of this landable carried a migration at all.
   - **Redefining the digest LATER is equally cheap**, for the same reason: it orphans a subtree that
     the reaping rule collects. Worth knowing, because the digest rule is the kind of thing that gets
     refined.

2. **The generation registry, the canonical pointer, and the caps** — creating a generation, moving
   the pointer (forward and back), refusing at a cap, deleting a generation or a stream.
   Independently testable with no indexer running. **It also owes the seeding spec its one
   obligation**: creating a generation takes its starting stream as an INPUT, so a generation never
   assumes it must fetch its own history. Build creation backfill-only and
   `a-generation-can-be-seeded-from-a-published-artifact` has to re-open the seam the split was made
   to avoid, so it needs an acceptance criterion here.
3. **The verdict becomes a published, actionable answer.** `sourceInvalidationOf` is INTERNAL
   (`packages/core/src/index.ts` re-exports only `ReorgCause`/`ReorgDetection` from that module, and
   core's `exports` map is `.` plus `./package.json`), and `updateIndexer` computes the verdict then
   discards it — the code says the block "is carried no further than the log line". The container is
   browser-side, so the verdict must cross that boundary. ADDITIVE: it publishes the verdict and grows
   `ReconfigureOutcome` while the verbs still discard as they do today; landable 4 removes the
   discard when it lands the container that replaces it. Keep the two-step, but for the RIGHT reason:
   it is NOT to spare a consumer a breaking change (nothing is published, `CONTEXT.md`), it is so
   each landable lands GREEN on its own, which is `TASKING-PROTOCOL` section 3a's expand-then-contract
   and applies whatever the release status. Includes the `stateDiscarded` sweep, **38**
   references — `packages/core` (11), `packages/browser` (23), `examples/browser-reference` (2),
   `docs/guide/indexing-in-a-browser-app/index.md` (2).
4. **The container plus the factory migration.** The indirect handle, per-generation state factories,
   and passing the processor factory rather than its result. **It owns the READ UNIT OF WORK in the
   browser**, which is the interval between notifications: the pointer move is applied AT a
   notification, so reads between two of them see one generation, and a read outside any subscription
   resolves per call. That reuses the existing subscribable stores rather than adding a scope API.

   **It also owns the `EthereumIndexer` RENAME, which `CONTEXT.md` promises and nothing else
   delivers.** That class is one source plus one processor plus one state, which under this spec is a
   GENERATION and not the container, so the name means the wrong thing the moment the container
   exists. This landable is where the container lands, so it is where the rename belongs; left
   unowned it becomes a wide refactor discovered mid-task. Note it is NOT covered by the 37 call
   sites counted below, which are `createIndexerState` invocations rather than uses of the class. This landable also DISCHARGES
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
5. **Pause and resume by CAP AND DRAIN** — cap `toBlock`, keep polling until the cap falls below
   `latestBlock - finality`, then idle; resume by removing the cap. It truncates nothing and reverts
   nothing, and `revertTo` is NOT on this path. Two build details the prose settles: the cap must be
   applied to `toBlock` BEFORE the existing `fromBlock > toBlock` guard, and `lastSync.latestBlock`
   must keep tracking the REAL head — capping that too makes `getFromBlock` return
   `latestBlock - finality` forever and the drain never idles. Owns the DRAINING state a consumer can
   see, which otherwise falls between this and landable 6.
6. **The PROMOTION POLICY** — the three values, the `on-catch-up` DEFAULT, the `immediate` opt-in, the
   TRIGGER (the successor reaching the cursor the canonical generation had), and drop-on-promotion
   with its `immediate`-only deferral. It was decided in prose and owned by nothing, which left
   stories 1, 3, 13 and 14 with no delivering task — including the production default and the one
   story 1 asks for. It cannot fold into landable 2, which is explicitly testable with no indexer
   running, because the trigger needs a running one — which is landable 8. `blockedBy` 2, 4 and 8.
7. **Progress and degradation** — `SyncingState` reporting that a non-canonical generation exists and
   how far it has caught up (story 5), and the fallback when a generation's stream is unavailable or
   unreadable: a full re-index, which is today's behaviour, so the feature degrades rather than
   breaks (story 12). Small, but it was unowned, and story 12 is the guard that stops a corrupt
   stream taking the app down with it.

8. **RUNNING a non-canonical generation** — a second generation that actually INDEXES: its own
   fetch-and-fold loop, its own cursor and stream, alongside the canonical one. Named separately
   because it was UNOWNED and is the capability the headline rests on. Landable 4's container HOLDS
   generations and landable 2's registry CREATES them (both explicitly testable with no indexer
   running); landable 5 owns only PAUSING one; landable 6's promotion TRIGGER — the successor
   reaching the cursor the canonical generation had — presupposes a successor that is moving. So
   stories 1, 3, 13 and 14 all need this and none of the other landables delivers it.

   It owns the duplicated head-following fetch the Solution section prices ("indexing costs a
   duplicated head-following fetch"), and it must decide ONE thing the prose leaves open: whether the
   two generations poll INDEPENDENTLY or share one head fetch fanned out to both folds. Independent
   is the honest default because two generations may sit on different STREAMS with different
   filters, and sharing is only expressible where they sit on the SAME stream. Do not build the
   shared path first. `blockedBy` 2 and 4; landable 6 is `blockedBy` this.

Landables 3, 4, 5, 6, 7 and 8 all edit `packages/browser/src/IndexerState.ts` (`SyncingState` at the
top, `createIndexerState`, three `stateDiscarded` sites, and the container is what it returns), so
serialise them with `blockedBy`. A workable order is (1) and (2), then (3), then (4), then (8), then
(5), then (6), then (7).

**Story-to-landable map, so a hole is visible rather than argued:** 1 → 6 (over 8 and 4); 2 → 1 + 4;
3 → 1 + 6 (over 8); 4 → 2; 5 → 7; 6 → 4; 7 → 3; 8 → 2; 9 → 2; 10 → 5; 11 → 1; 12 → 7;
13 → 6 (over 8); 14 → 6 (over 8). Every story has a deliverer and no landable is an orphan. The
four stories annotated "over 8" are the ones landable 8 lists as needing a RUNNING non-canonical
generation; 6 is what makes each of them observable, which is why 6 is the named deliverer and 8 is
the dependency.

## Out of Scope

- **Sharing a prefix between two streams.** The named, deliberately-declined optimisation: when a new
  filter is a superset of an old one, the new stream is identical to the old up to some point and
  could reuse it.

  **If it is ever built, it makes a REMOVABLE thing PERMANENT, and that cost must be counted at the
  time.** `appending-to-the-stream-costs-the-batch` keeps a prefix on a gap rather than clearing, and
  isolates that recovery so it can be dropped later; the SCANNED EXTENT a sealed segment carries
  exists solely to enable it and is required to have exactly one reader. Prefix sharing wants that
  same extent for a second purpose, which would make both it and the recovery load-bearing forever.
  Note also that it is not as cheap as it sounds: a segment lives under exactly ONE stream's subtree
  and a superset filter yields a DIFFERENT digest, so reuse needs an indirection from one stream's
  address to another's segments — which is the head pointer that spec rejected on merit, and which
  hierarchical addressing makes no easier. Worth doing later, and cheap to add because streams are addressed by digest and
  nothing about this design assumes a stream was fetched entirely by its own generation. Not now: it
  buys a rare case and it is where all the complexity of the superseded design lived.
- **Sharing streams ACROSS named indexers.** Reachable; see the multi-tenancy decision for why not
  first.
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
is pinned in the `CONTEXT.md` glossary alongside `stream`, `indexer` and `canonical pointer`.

The design record `work/notes/ideas/stream-grafting-what-we-established.md` carries the invariants
this rests on and the options weighed, including the two-generation design this replaces.
