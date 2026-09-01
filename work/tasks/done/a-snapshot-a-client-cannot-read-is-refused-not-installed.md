---
title: 'A published snapshot a client cannot read is REFUSED, not installed as state'
slug: a-snapshot-a-client-cannot-read-is-refused-not-installed
covers: []
blockedBy: []
needsAnswers: true
---

## What to build

The one corner where `tagged-bigint-codec-across-storage-adapters` left its own failure mode alive, knowingly, because closing it is a seam decision rather than a line of code.

`keepStateOnIndexedDB(name, remote)` (`packages/browser/src/storage/state/OnIndexedDB.ts`) fetches a snapshot published by `@etherfold/cli`'s keeper. That file carries a format number — the CLI bumped `SNAPSHOT_FORMAT` to 2 precisely so a reader can tell the encodings apart, and the CLI **refuses** a format-1 file locally, logging it and cold starting. The browser does not read the number at all.

So the same bytes are refused on one path and installed on the other. A format-1 snapshot loads, and because there is no fallback reviver any more (ADR-0029, correctly), every `uint256` in `lastSync.unconfirmedBlocks[].events[].args` arrives as the string `"123n"` instead of the BigInt `123n`. The client then indexes on top of state whose types are silently wrong — the exact plausible-wrong-answer failure the tagged codec was adopted to remove, arriving through the one door left unwatched.

**It is currently unreachable, and that is the reason to fix it now rather than later.** Nothing is published under `@etherfold` yet, so no format-1 snapshot exists in the wild to be mis-read. `publish-etherfold-and-deprecate-old-names` is what makes it reachable, and after that the same fix has to be shipped as a breaking correction to something already published rather than as a guard that was always there.

### The actual problem is WHERE the number lives

`SNAPSHOT_FORMAT` is `@etherfold/cli`'s own constant, and `@etherfold/browser` does not depend on `@etherfold/cli` — nor should it: the CLI is a node deployable and the browser package must stay bundleable for a tab (`packages/browser/test/bundlesForABrowser.test.ts` pins that, and the reason `@etherfold/utils/indexer` exists at all is that the barrel dragged `node:fs` in).

So this is a placement question before it is a validation question. The writer and every reader of a published snapshot must agree on one number, and today they cannot even see it. `@etherfold/core` is the obvious home — both packages already depend on it, `contextFilenames` in `@etherfold/utils/indexer` already establishes that the naming scheme a snapshot is fetched under must be singular for the same reason, and a format number is a smaller thing than the codec that already lives there.

Decide it and say why. What must NOT happen is a second constant in the browser package kept in step with the CLI's by attention.

**FIRST, though: there are ALREADY TWO exported symbols named `SNAPSHOT_FORMAT`, for two unrelated
artifacts, and "one `SNAPSHOT_FORMAT`" is therefore NOT the goal.** `packages/cli/src/keepState.ts`
exports `SNAPSHOT_FORMAT = 2` for the free-form BLOB envelope (the one this task is about), and
`packages/state-store/src/snapshot.ts` exports `SNAPSHOT_FORMAT = 1` for the ENTITY snapshot envelope
(refused via `SnapshotFormatError`). They version DIFFERENT file shapes and must stay independent —
merging them would make one envelope's revision falsely invalidate the other's. `@etherfold/browser`
already depends on `@etherfold/state-store`, so both are reachable from the very reader being fixed,
and `packages/core/src/utils/bigint.ts` already has to disambiguate them by hand in prose.

So the real requirement is **one constant PER ENVELOPE, each in a package its writer and all its
readers can import, and NAMED so the two cannot be confused at a call site.** Moving the CLI's number
into `@etherfold/core` under the same bare name would create a THIRD identical identifier in a graph
where all three are importable together, which is worse than the problem. Rename as you relocate
(something like `BLOB_SNAPSHOT_FORMAT` beside `ENTITY_SNAPSHOT_FORMAT`, or a single namespaced
object) and say what you chose.

### What a refusal means here, which is not obvious

The CLI's answer to an unreadable snapshot is a cold start: log it and index from the start block, because re-indexing is its existing recovery. A browser client has the same recovery available and it is more expensive (it is why snapshots exist at all), so state the behaviour deliberately rather than inheriting it by accident:

- **Refuse and fall through to the next mirror.** `keepStateOnIndexedDB` already fails over when a mirror is unreachable, and an unreadable format is a mirror that cannot serve this client. That reuses behaviour the path already has.
- **Refuse everything and start from the start block.** Correct but expensive, and only right when no mirror can serve.
- Do NOT translate. That is the fallback ADR-0029 rules out, and the translation IS the guess.

Prefer LOCAL state when local is already ahead, exactly as the existing `fetch` does — a client with usable local state should not be dragged back to a cold start by a stale published file.

**A bare remote `lastSync` file has no format at all**, and that is part of this task rather than an excuse. `getURL(remote, context, true)` fetches it to compare mirrors before downloading a payload. Decide what an unversioned file means to a versioned reader and record it; "assume it is current" is a decision that must be made deliberately if it is made.

### Scope

The consuming side only, and only the free-form path's keeper. The entity path's `bootstrapFromSnapshot` (`@etherfold/processor-entities`) already refuses a `SnapshotFormatError` and a processor-version mismatch, so it is the shape to mirror rather than the thing to change. Publishing snapshots as a first-class artifact remains its own spec.

## Acceptance criteria

- [ ] ONE format constant PER ENVELOPE, each in a package its writer and every reader can import, and the two DISTINGUISHABLE by name at a call site. No second constant for the SAME envelope kept in step by attention, and no third identifier spelled `SNAPSHOT_FORMAT` added to a graph that already has two.
- [ ] A remote snapshot whose format the client does not recognise is REFUSED, never installed, and the refusal is visible (logged with the location and both numbers) rather than silent.
- [ ] A test proving the failure this closes: a format-1 payload offered to `keepStateOnIndexedDB` must not produce state whose `args` are `"123n"` strings. Assert the TYPE, not just the value, since that is the whole defect.
- [ ] Failover is exercised: an unreadable mirror falls through to a readable one, and the readable one's state is what loads.
- [ ] Local state that is already ahead still wins over a remote snapshot, unreadable or not.
- [ ] The unversioned bare `lastSync` file has a stated, tested meaning.
- [ ] `@etherfold/browser` still bundles for a browser (`bundlesForABrowser.test.ts` still passes) and gains no node-only dependency.
- [ ] Tests in the affected packages' `test/`, vitest, plus a changeset for every published package whose surface changed.

## Blocked by

- None. Better done BEFORE `publish-etherfold-and-deprecate-old-names`, which is what turns this from an unreachable gap into a live one.

## Prompt

> Close the last corner where an unreadable published snapshot is installed instead of refused, in the `etherfold` monorepo.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED). If a dependency landed differently, or an ADR superseded an assumption here, do NOT build on the stale premise — route to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal"). In particular re-check the two existing `SNAPSHOT_FORMAT` constants named below before designing the placement, and re-check whether `retire-the-js-object-processor-path` has landed — it may have removed the free-form keeper this task hardens, in which case STOP and surface that rather than hardening something on its way out.
>
> Then read `packages/browser/src/storage/state/OnIndexedDB.ts` — the module note names this gap explicitly and is where the reasoning starts — then `packages/cli/src/keepState.ts` (the writer, and the local reader that DOES refuse a format it cannot read), ADR-0029, and `packages/processor-entities/src/snapshot.ts` for the shape to mirror (`SnapshotFormatError`, plus a processor-version check).
>
> The defect: the CLI refuses a format-1 snapshot locally and cold starts; the browser reads the same bytes without checking the number, and since ADR-0029 removed every fallback reviver, each `uint256` in `lastSync.unconfirmedBlocks[].events[].args` arrives as the STRING `"123n"` rather than a BigInt. The client then indexes on top of silently mistyped state, which is the failure the tagged codec exists to prevent.
>
> The real problem is placement, not validation — and note that TWO exported symbols named `SNAPSHOT_FORMAT` already exist, for different envelopes: the CLI's (`keepState.ts`, = 2, the blob) and the entity path's (`packages/state-store/src/snapshot.ts`, = 1). Keep them independent and make them distinguishable by NAME; do not merge them and do not add a third under the same spelling. `SNAPSHOT_FORMAT` as this task means it is the CLI's own constant and `@etherfold/browser` must not depend on `@etherfold/cli` — the browser package has to stay bundleable for a tab, which `bundlesForABrowser.test.ts` pins and which is why `@etherfold/utils/indexer` exists. Put the number where the writer and every reader can see it, `@etherfold/core` being the obvious candidate, and record the choice. A second constant in the browser kept in step by attention is the one outcome to avoid.
>
> Refuse; do not translate. Translating is the fallback ADR-0029 rules out, and the translation IS the guess. An unreadable mirror should fail over to the next one, since that path already fails over for an unreachable mirror, and local state that is already ahead must still win.
>
> Decide what an UNVERSIONED bare remote `lastSync` file means to a versioned reader, and test it. "Assume it is current" is defensible but must be chosen rather than defaulted into.
>
> Do this BEFORE `publish-etherfold-and-deprecate-old-names`: today no format-1 snapshot exists in the wild, so this is a guard being added; afterwards it is a breaking correction to something already shipped.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your final report, in particular where the format number now lives and what an unversioned file means.

## Decisions

- **The blob format number lives in `@etherfold/core` as `BLOB_SNAPSHOT_FORMAT`** (with `isReadableBlobSnapshot` and the `BlobSnapshotEnvelope` type), per the task's steer — the writer (CLI) and every reader (CLI local, browser remote) import one number, and core is where the codec the number versions already lives. Alternatives rejected: a duplicate constant in the browser kept in step by attention (the outcome to avoid); `@etherfold/browser` depending on the CLI (unbundleable for a tab); re-exporting it from the CLI (two importable homes for one number). Touches: `@etherfold/core` and `etherfold` public surfaces, and the future `publish-etherfold-and-deprecate-old-names` task, which now publishes under a constant whose name says which envelope it versions.
- **One constant PER ENVELOPE, renamed as relocated**: state-store's `SNAPSHOT_FORMAT` (= 1) became `ENTITY_SNAPSHOT_FORMAT`. The two version different file shapes and revise independently, so merging them would let one envelope's revision falsely invalidate the other's, and `@etherfold/browser` (now importing both) is exactly the call site where a bare `SNAPSHOT_FORMAT` would be a coin toss. Touches: `@etherfold/state-store`, `@etherfold/processor-entities` (re-export), `@etherfold/state-store-conformance` (internal), all covered by changesets. Recorded as **ADR-0040**.
- **An unversioned bare `lastSync` file means SELECTION DATA ONLY**: it is read without a format check, deliberately. The one field used from it is `lastToBlock` (a plain number, identical under every encoding), nothing from it is ever installed, and the file that IS installed (the state file) carries the check — so a stale head can mis-order the mirrors but cannot smuggle an unreadable payload past them. The alternative — refusing the head — would make every mirror the CLI publishes unselectable (it writes the head bare by design), a guard placed where the damage is not. Not "assume it is current" in the strong sense: its claim is only ever used to order mirrors, never trusted as state. Touches: `keepStateOnIndexedDB`, and the publishing-snapshots design when it comes.
- **Failover depth preserved, not converged**: an unreadable winner fails over to exactly the next mirror (winner + one), as the path already did for an unreachable one — I did NOT adopt the entity path's walk-every-remaining-candidate, because converging the two free-form/entity behaviours is `retire-the-js-object-processor-path`'s business (it is blocked by this task and will delete this code path). Touches: that backlog task; CONTEXT.md's claim that the free-form keeper does not walk every candidate remains true. Recorded in ADR-0040's rejected-alternatives.
- **URL-form mirrors are refused at selection, prefix-form at payload** — a consequence of where each shape's bytes are already downloaded, not a new policy; both refusals log the location and both numbers.
