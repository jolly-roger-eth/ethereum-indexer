---
title: 'A published snapshot a client cannot read is REFUSED, not installed as state'
slug: a-snapshot-a-client-cannot-read-is-refused-not-installed
covers: []
blockedBy: []
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

- [ ] One `SNAPSHOT_FORMAT`, in a package the CLI's writer and the browser's reader can both import. No second constant kept in step by attention.
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

> Close the last corner where an unreadable published snapshot is installed instead of refused, in the `etherfold` monorepo (the repository directory is still named `ethereum-indexer`).
>
> FIRST read `packages/browser/src/storage/state/OnIndexedDB.ts` — the module note names this gap explicitly and is where the reasoning starts — then `packages/cli/src/keepState.ts` (the writer, and the local reader that DOES refuse a format it cannot read), ADR-0029, and `packages/processor-entities/src/snapshot.ts` for the shape to mirror (`SnapshotFormatError`, plus a processor-version check).
>
> The defect: the CLI refuses a format-1 snapshot locally and cold starts; the browser reads the same bytes without checking the number, and since ADR-0029 removed every fallback reviver, each `uint256` in `lastSync.unconfirmedBlocks[].events[].args` arrives as the STRING `"123n"` rather than a BigInt. The client then indexes on top of silently mistyped state, which is the failure the tagged codec exists to prevent.
>
> The real problem is placement, not validation. `SNAPSHOT_FORMAT` is the CLI's own constant and `@etherfold/browser` must not depend on `@etherfold/cli` — the browser package has to stay bundleable for a tab, which `bundlesForABrowser.test.ts` pins and which is why `@etherfold/utils/indexer` exists. Put the number where the writer and every reader can see it, `@etherfold/core` being the obvious candidate, and record the choice. A second constant in the browser kept in step by attention is the one outcome to avoid.
>
> Refuse; do not translate. Translating is the fallback ADR-0029 rules out, and the translation IS the guess. An unreadable mirror should fail over to the next one, since that path already fails over for an unreachable mirror, and local state that is already ahead must still win.
>
> Decide what an UNVERSIONED bare remote `lastSync` file means to a versioned reader, and test it. "Assume it is current" is defensible but must be chosen rather than defaulted into.
>
> Do this BEFORE `publish-etherfold-and-deprecate-old-names`: today no format-1 snapshot exists in the wild, so this is a guard being added; afterwards it is a breaking correction to something already shipped.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your final report, in particular where the format number now lives and what an unversioned file means.
