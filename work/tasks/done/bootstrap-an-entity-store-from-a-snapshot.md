---
title: Bootstrap an entity store from a published snapshot, without letting it claim history it never received
slug: bootstrap-an-entity-store-from-a-snapshot
spec: one-processor-everywhere
blockedBy: [backend-neutral-entity-event-processor, index-in-the-browser-with-a-chosen-backend]
covers: [1, 6]
---

## What to build

Parity for a capability the free-form path already ships and the entity path would otherwise silently lose: a client that starts from state somebody else already computed, instead of replaying the chain from the start block.

`keepStateOnIndexedDB(name, remote)` (`packages/browser/src/storage/state/OnIndexedDB.ts`) takes a URL, an `IndexedStateLocation`, or an ARRAY of them. Its `fetch` pulls each mirror's `lastSync`, picks the one with the highest `lastToBlock`, prefers LOCAL state when local is already further along, and fails over to the next mirror when one is unreachable, logging rather than dying. The CLI has the file form of the same idea with a versioned envelope: `{format, processor, savedAt, lastSync, state, history}` (see `.changeset/cli-snapshot-envelope.md`), which also carries the processor version hash so a snapshot computed by a different processor is caught rather than trusted.

This task gives the entity path the same ability. An entity store's contents are versioned rows rather than a blob, so the snapshot's SHAPE is different, but the user-visible capability must be the same: point a browser client at one or more published locations and have it start near the tip.

### The trap, and it is the whole reason this task is written carefully

A snapshot of CURRENT rows carries no history below the block it was taken at. A store loaded from it therefore cannot answer an as-of read below that block, cannot revert below it, and **must not claim it can**. A freshly-migrated store reports `unbounded` because that is true of it; a bootstrapped store that inherits that report would be claiming history it never received, and would answer a historical read with a confident wrong number. That is precisely the failure `one-processor-everywhere` exists to prevent, arriving through a door nobody was watching.

So a bootstrapped store's retention floor comes FROM the snapshot, not from its configuration. The vocabulary for this already exists and should be reused rather than reinvented: the honest report is a window that starts at the snapshot's block (or `revert-only` if the snapshot carries no history at all), the refusal is `BlockNotRetainedError`, and `state-store-patch` already demonstrates the shape of refusing a revert that reaches past what is retained (`REFUSES a revert whose reverse patches have been pruned`, `names the depth it could not reach`).

**Reorg safety is the sharp edge.** A snapshot taken at block N with no history below it cannot survive a reorg that reaches below N. Either the snapshot is taken far enough behind the tip that a reorg cannot reach it (which is what the finality depth is for), or the store must refuse such a revert loudly rather than silently producing wrong state. Decide which, and say so; do not leave it to chance.

### What is in a snapshot is yours to decide

The genuine open question, and the one to record reasoning for:

- **Current rows only** — small, simple, and the store bootstraps with a retention floor at the snapshot block. History below it is gone.
- **Rows plus some version history** — bigger, but the bootstrapped store can answer as-of reads and revert into the retained range, so its capability report is a real window rather than a floor at the tip.

The measured context is worth consulting before choosing: `work/notes/findings/sqlite-in-the-browser.md` records the real game at 4,072 live rows against 29,393 versions, so history is roughly seven times the current state on that workload, and the whole gzipped event stream is 0.6 MB. If a snapshot of full history approaches the size of just replaying the stream, that is an argument about which one you are actually saving the client.

Whatever the shape: the snapshot must carry the cursor that belongs to its contents, they must be installed together as one unit, and the processor version must be checked so a snapshot from a different processor is refused rather than loaded (the free-form envelope already does this, and `processor-version-hash-cannot-silently-lie` is the landed task behind it).

### Scope

This is the CONSUMING half: a store can be bootstrapped, honestly, from a snapshot that exists. Producing snapshots as a first-class published artifact — a publish command, a format version, mirror layout, retention of old snapshots, and how `snapshot-prune-script` fits — is a larger design that deserves a spec of its own rather than being smuggled in here. Write whatever minimal producer the tests need, and say plainly that it is test scaffolding rather than the shipping story.

## Acceptance criteria

- [ ] An entity store can be created from a snapshot plus its cursor, installed as ONE unit, and an indexer resumes from it rather than from the start block.
- [ ] A bootstrapped store reports a retention floor derived from the SNAPSHOT, never `unbounded`-by-default. A test asserts that a store bootstrapped at block N refuses an as-of read below N with the typed refusal, and answers correctly at and above it.
- [ ] A snapshot produced by a different processor version is REFUSED, with a message naming both versions.
- [ ] A revert that would reach below the bootstrapped floor is refused loudly and changes nothing, or is impossible by construction because of where snapshots are taken. Whichever, it is tested and the reasoning is recorded.
- [ ] Parity with the free-form path's fetch behaviour: several locations may be given, the most advanced is chosen, an unreachable one fails over, and local state is preferred when it is already further along. If any of that is deliberately not carried over, say which and why.
- [ ] What a snapshot contains is an explicit decision with its reasoning, including the size trade-off against simply replaying the captured stream.
- [ ] The conformance suite covers bootstrap-then-read on every backend that can support it, so a future backend inherits the obligation rather than rediscovering the trap.
- [ ] Tests in the affected packages' `test/`, vitest, plus a changeset for any published package whose surface changed.

## Blocked by

- `backend-neutral-entity-event-processor`: it owns the cursor port, and the property that a store's contents and cursor are settable together as one unit.
- `index-in-the-browser-with-a-chosen-backend`: the browser is where this capability is worth having, and where parity with `keepStateOnIndexedDB` is judged.

## Prompt

> Give the entity path the snapshot bootstrap the free-form path already has, in the `etherfold` monorepo (the repository directory is still named `ethereum-indexer`): a client that starts from state someone else computed instead of replaying the chain.
>
> FIRST read `packages/browser/src/storage/state/OnIndexedDB.ts` (the `fetch` half is the behaviour to match: mirrors, latest `lastToBlock` wins, prefer local when local is ahead, fail over on error), `.changeset/cli-snapshot-envelope.md` for the existing envelope, and confirm `backend-neutral-entity-event-processor` landed and what it decided about setting contents and cursor together.
>
> The trap is the point of the task. A snapshot of current rows carries NO history below the block it was taken at, so a store loaded from it must report a retention floor derived from the snapshot and refuse as-of reads below it with `BlockNotRetainedError`. A bootstrapped store that reports `unbounded` because that is what a fresh store says would answer historical reads with confident wrong numbers, which is the exact failure this spec exists to prevent. Reuse the retention vocabulary rather than inventing a parallel one.
>
> Reorg safety needs a deliberate answer: a snapshot at block N with no history below it cannot survive a reorg reaching below N. Either snapshots are taken behind the finality depth so it cannot happen, or the store refuses that revert loudly. Choose, test it, and record which.
>
> What goes IN a snapshot is your call: current rows only (small, floor at the snapshot block) or rows plus history (bigger, a real window). Read `work/notes/findings/sqlite-in-the-browser.md` first: 4,072 live rows against 29,393 versions on the real workload, and the whole gzipped stream is 0.6 MB — if full history approaches the cost of just replaying the stream, that is an argument about what you are really saving the client.
>
> A snapshot from a different processor version must be refused, not loaded. The free-form envelope already carries the version hash and `processor-version-hash-cannot-silently-lie` is the landed task behind it.
>
> Scope: this is the CONSUMING half. Publishing snapshots as a first-class artifact — a publish command, format versioning, mirror layout, pruning old ones — is a spec of its own. Write only the producer your tests need and say that is what it is.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your final report, in particular what a snapshot contains, how the retention floor is derived, and how reorg below the floor is handled.

## Decisions

**A snapshot contains CURRENT ROWS ONLY.** Measured, not assumed (`docs/spikes/bootstrap-an-entity-store-from-a-snapshot/`, the launched stratagems workload): a current-rows snapshot is **45.6 KB gzipped = 7% of the 619.6 KB gzipped stream**, while every version in the same encoding is **304.6 KB = 49% of the stream** and 6.7x the current-rows one. A client willing to pay 305 KB is most of the way to paying 620 KB for the stream, which it can replay into a store that then holds history it verified itself. Decisively, a full-history snapshot is not expressible through the seam at all: a version is what applying a block PRODUCES, and a write surface that could set `_lower`/`_upper` could manufacture states no sequence of blocks could reach. Alternatives considered: rows plus a retained window (rejected on the numbers and on the new write surface it would need); rows plus the tail of the stream (rejected as a second format for something `replayStream` already does). Touches: what a consumer's capability report inherits, and therefore the publishing spec. Recorded as **ADR-0028**.

**The floor is expressed as a WINDOW, not a new `Retention` kind.** A bootstrapped store's retained range is `[snapshotBlock, tip]`, i.e. a window of `tip - snapshotBlock` blocks, and intersecting it with a configured window is `min` of two distances — so `retentionFloor`, `retainedRange`, `assertRetained` and the conformance suite's `claimedDepth` all keep working untouched. Alternative considered and rejected: a fourth kind (`{kind: 'from-block', from: N}`), which is exact but re-means "retention" (what a deployment SETS) to also cover "where history begins", and would force every backend, the patch store and the suite to learn it. **Cost, recorded because a reviewer should see it:** a window is a distance from a tip and the seam has no verb reporting one, so the handle tracks the highest block it has seen. Between a reload and the first `applyBlock` of that session it therefore *under*-claims (never over-claims) and corrects itself immediately. Touches: `StateStoreCapabilities` consumers.

**Reorg below the floor: refuse loudly AND decline the snapshot that invites it.** The task allowed either. Refusal is the consumer-side half that cannot be delegated (there are no versions under the snapshot to reopen at any price, and a partly-undone reorg is a plausible wrong state — the same reasoning `RevertBeyondPatchHistoryError` records). Prevention is the producer's job and unverifiable after the fact, so `bootstrapFromSnapshot` does the half it can: given `finalityDepth`, a candidate taken within that many blocks of the tip its producer had observed is not adopted. `RevertBeyondSnapshotError` is deliberately NOT a `BlockUnavailableError` (that family is the read path). Touches: `EntityEventProcessor.process` now has a reachable throw on a deep reorg; a host's answer is to re-bootstrap.

**COHERENCE: the snapshot origin lives at the CURSOR PORT, under a second key.** The port is documented as "how far a processor has got", so a second key holding something else is a mild widening. The port is really a keyed opaque-string slot the store never interprets, never versions, never reverts and never prunes — exactly the durability a history floor needs — and the conformance suite already asserts two keys are kept apart. The alternative (a new `readMeta`/`writeMeta` port) would be a second slot with identical semantics that every backend implements twice. Touches: every `StateStore` implementation (no code change; a reserved key name), and anyone later tempted to key cursors by context.

**COHERENCE: "snapshot" now names two shapes, one meaning.** The free-form path's snapshot is the whole state blob in the CLI file envelope; this is its entity-path counterpart. I reused the word rather than inventing one (CONTEXT.md already says etherfold "hydrat[es] clients from pre-computed snapshots"), and the glossary entry now states both shapes and what only the entity one owes: a history floor.

**Install ORDER is marker-first, and it is not arbitrary.** The seam carries one cursor slot per `applyBlock` and the sync cursor has it, so the origin marker is a separate write. Marker-first leaves a crash with a floor over an empty store (over-cautious, self-healing on re-run); marker-last leaves rows with no floor, which is the exact failure this task exists to prevent. Same principle as the memory store writing its cursor last: where atomicity is unavailable, the order must be the safe one.

**Two deliberate departures from the free-form `fetch` behaviour, both strengthenings.** (1) Failover walks every remaining candidate in descending order, where `keepStateOnIndexedDB` tries the winner and exactly one more (its source says `// TODO more than 2`). (2) A snapshot from another processor version is not a candidate at all; the free-form keeper does not check. Also **not carried over**: the `{prefix}` location form, which builds filenames from a `ProcessorContext` via `@etherfold/utils/indexer`. The entity envelope carries `takenAt` and `processor` at the top level, so selection needs no filename convention; the object form is `{url, head?}` instead, where `head` is the same envelope without `rows`. A published mirror layout is the publishing spec's decision, and inventing one here would pre-empt it.

**The mirror logic lives in `@etherfold/processor-entities`, not `@etherfold/browser`.** "Is local already ahead" means reading `lastToBlock` out of a stored cursor, and the cursor is an opaque string at the seam (ADR-0027) whose codec is the entity runtime's. `@etherfold/browser` deliberately types the entity path structurally so it depends on no processor package, and putting this there would invert that. Browser gains documentation only (patch changeset). Touches: where a browser author looks — hence the pointer added to `createBrowserStateStore`'s docs.

**`openSnapshotAware` migrates the store itself.** It must read the marker, and a store that has not been migrated has nothing to read from (SQLite raises `no such table: _cursor`). Making it a migrating call means it REPLACES the `migrate()` a host would otherwise call rather than adding a step whose omission throws. Alternative rejected: documenting "migrate first", which is a rule that gets broken once and fails at the boundary furthest from where it was broken.

**`revertTo(-1)` is a wipe, not a reorg, and drops the floor.** `EntityEventProcessor.reset()`/`clear()` is that call and had to keep working; a store with no rows has no snapshot-derived history to be honest about, so it goes back to claiming what it was configured to keep. `0 <= keepUpTo < origin` is the refused case.
