---
title: 'A generation can be seeded from a published artifact, because on a public node a browser often cannot backfill at all'
slug: a-generation-can-be-seeded-from-a-published-artifact
needsAnswers: true
taskedAfter: [a-reconfigure-is-not-an-outage]
---

> Launch snapshot, records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

> **SPLIT out of `a-reconfigure-is-not-an-outage`** under `TASKING-PROTOCOL` §2a: that spec's other
> stories are all build-taskable now, this one is GATED on two things that do not exist, and tasking
> the confident subset while leaving this in prose is the mis-scope §2a exists to catch.

<!-- open-questions -->

## Open questions

1. **What is the remote-loading seam?** `loadStreamFixture` reads a LOCAL path
   (`@etherfold/conformance-workload-stratagems`), and only the STATE snapshot path has a remote
   (`keepStateOnIndexedDB(name, remote)`, `IndexedStateLocation`). Does a captured stream get the
   same treatment, a new loader, or does it ride on the snapshot mechanism?
2. **What does the published artifact look like on the wire?** `StreamFixture` exists and has a
   `format` number and provenance, and the repo already gzips one (0.6 MB against 20.5 MB). Is the
   published seed literally that, or a chunked/resumable form? A 20 MB single blob installs badly on
   a phone and cannot resume.
3. **Who verifies a seed, and against what?** A seed is somebody else's claim about a chain. The
   snapshot path has ADR-0028's floor and a refusal for an unreadable snapshot
   (`work/tasks/backlog/a-snapshot-a-client-cannot-read-is-refused-not-installed.md`). A stream seed
   has no equivalent, and it carries EVENTS a processor will fold, so a bad one is worse.
4. **Does a seeded stream keep being fetched from the same filter digest?** If the publisher's source
   and the client's source differ at all, the digest differs and the seed installs under a key
   nothing will read. Is that a refusal, or does the seed carry its digest and get checked?

<!-- /open-questions -->

## Problem Statement

`a-reconfigure-is-not-an-outage` says a filter change makes a new stream, and a new stream is
backfilled from the node. In a browser, for a real user, that is frequently **impossible rather than
slow**: public nodes commonly do not serve old logs at all. Base's public endpoints are the worked
example, and it is why stratagems ships a remotely-computed snapshot rather than indexing from
genesis in the browser.

So the generation model has a hole exactly where its most valuable case lives. A developer changing
an ABI on a local node is fine. A shipped app whose filter changed cannot rebuild on the user's
machine.

The deployment reality points the same way: a filter change means the user is getting a **new client
build** anyway, so the app is already shipping something, and a stream or a snapshot is one more
artifact alongside it.

## Solution

Creating a generation accepts a **SEED** as an alternative to a backfill. `a-reconfigure` already
requires that a generation take its starting stream as an INPUT rather than assuming it fetches its
own history; this spec supplies the artifact, the loader and the rules.

**Two seed shapes, and they are NOT equivalent.** Both partly exist and this reuses rather than
invents:

- **A captured STREAM** (`captureStream`, `StreamFixture`, and today `replayStream`, which returns an
  `ExistingStream`). Seeds the stream itself, so every later generation over that stream can re-fold
  from it. This is the shape that composes with the generation model.
- **A state SNAPSHOT** (ADR-0028, `bootstrapFromSnapshot`, and the `remote` argument
  `keepStateOnIndexedDB` already takes). Seeds the FOLD, not the stream, so the generation reports a
  retention FLOOR at the snapshot's block and refuses reverts and as-of reads beneath it.

The distinction is the load-bearing part: a snapshot-seeded generation **cannot serve a later
processor-only change**, because there is no stream under it to re-fold. It is a LEAF. That forfeits
exactly the case the generation model makes free, so publish a stream where you can and a snapshot
only where the stream is too large, accepting the floor.

## User Stories

1. As an APP AUTHOR shipping a client upgrade whose filter changed, I want the new generation seeded
   from an artifact I publish, so my users do not re-index from a chain their node will not serve.
2. As an APP AUTHOR, I want to publish a captured STREAM where I can, so my users' later
   processor-only upgrades stay free.
3. As an APP AUTHOR with a very large history, I want to publish a state SNAPSHOT instead and be told
   plainly what it costs me — a retention floor, and no re-fold for the next processor change.
4. As a USER installing a seed, I want a bad or unreadable artifact REFUSED rather than folded into
   my state, the same way a snapshot a client cannot read is refused rather than installed.
5. As a USER on a phone, I want installing a seed not to be a single 20 MB blocking blob.
6. As a developer, I want a seeded stream to be indistinguishable from a fetched one afterwards, so
   nothing downstream has to know how a generation started.

## Implementation Decisions

**None yet, deliberately.** The open questions above are genuine and two of them are seams that do
not exist. Writing decisions before answering them is what produced four rounds of corrections on
this family's other specs.

What IS decided, and inherited from `a-reconfigure-is-not-an-outage`: a generation takes its starting
stream as an input; a seeded stream is keyed by the same filter digest as a fetched one; and a
snapshot-seeded generation is a leaf.

## Out of Scope

- **The generation model itself**, which is `a-reconfigure-is-not-an-outage`.
- **How an app BUILDS or hosts the artifact** (CI, hosting, signing). `captureStream` already
  produces one; the publishing pipeline is
  `work/notes/ideas/publishing-snapshots-of-versioned-state.md`.
- **Snapshot verification**, to the extent it is already owned by
  `work/tasks/backlog/a-snapshot-a-client-cannot-read-is-refused-not-installed.md`.

## Further Notes

Note the interaction with `the-stream-stores-only-what-the-node-said`: that spec narrows the seam so
`replayStream` stops being an `ExistingStream`, and is `taskedAfter` `a-reconfigure` for exactly that
reason. Whichever of the two lands first, the seeding path must be written against the seam as it
stands THEN, and `CONTEXT.md`'s `seeding` entry updated with it.
