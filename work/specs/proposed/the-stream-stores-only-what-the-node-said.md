---
title: 'The stream stores only what the node said'
slug: the-stream-stores-only-what-the-node-said
taskedAfter: [appending-to-the-stream-costs-the-batch]
---

> Launch snapshot, records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

> **SPLIT out of `the-stream-is-what-the-node-said-appended-once` after four review rounds.** That
> spec bundled the append-cost change with this one. Every new blocker across all four rounds landed
> in THIS half, because it is a breaking public API change entangled with a third seam
> implementation, while the append half was stable from its second draft. Separating them means the
> append win can land without waiting on a type migration.

## Problem Statement

A stored `LogEvent` is two things at once: the raw log (`topics`, `data`, `address`), which is what
the node said and is true forever, and `args`/`eventName`, which is what SOME ABI made of it.

**Only the second can be wrong.** It goes stale whenever decoding moves without the fetch moving,
which is exactly what a renamed non-indexed parameter does: `topic0` hashes types and not names, so
every cached log is still exactly the right log while every cached `args` is filed under a key the
handler no longer reads.

ADR-0034 already had to work around this with an unconditional `reparse`: the stream cannot say per
event which ABI decoded it, so every replay re-decodes regardless. That is a workaround for storing
a derivation next to its source.

**This is a correctness-shaped problem, not a size one.** The repo's own numbers disagree about the
size: the capture script says 32.5 MB against 8.6 MB with `topics` and `data` stripped, while the
fixture README, the sqlite finding and two changelogs say 32.5 against 20.5. So `args` is somewhere
between 9 and 37 percent of a stream. Size is NOT the case for this change, and no task should quote
a figure without re-measuring.

## Solution

**The stream stores only what the node said**: raw logs plus the reorg flag the indexer derived; no
`args`, no `eventName`. Decoding happens on read, which is what `reparse` already does transiently
and what the fetch path pays anyway.

**This needs a NEW stored-event type that EXCLUDES the decoded half.** A raw-only event is not a
`LogEvent`: that is a union of `ParsedLogEvent` (carrying `args` and `eventName`) and
`LogEventWithParsingFailure` (carrying `decodeError`), and an event with neither belongs to neither.

Do NOT reuse `BaseLogEvent`. It already exists, is already exported, and is the SUPERTYPE every
decoded event extends (`ParsedLogEvent = BaseLogEvent & LogParsedData`). Reusing it would re-mean a
published type AND enforce nothing, because a decoded `LogEvent[]` is assignable to
`BaseLogEvent[]` — that is what a supertype is — and excess-property checks fire only on fresh
object literals. A keeper could receive, hold and persist decoded events in silence.

So mint a distinct name whose shape REFUSES the decoded half:

```ts
type StoredLogEvent<Extra = undefined> = BaseLogEvent<Extra> & {args?: never; eventName?: never; decodeError?: never};
```

**This form was verified with `tsc`, not reasoned about.** It rejects `ParsedLogEvent` both with and
without inputs, and rejects the union via `LogEventWithParsingFailure`, while accepting a raw event.
The repo does not set `exactOptionalPropertyTypes`, so the interaction that would otherwise make
`?: never` unreliable does not arise. One known hole, worth stating rather than hiding: an event
whose STATIC type has already been widened to `BaseLogEvent` still assigns, so the guard is at the
seam, not through a widening.

**`StreamFetcher` and `StreamSaver` move onto it.** That is a breaking `@etherfold/core` change and
it needs a changeset.

## User Stories

1. As a developer, I want the stream to hold what the node said and nothing derived from it, so
   nothing in it can disagree with my current ABI.
2. As an implementor of `ExistingStream`, I want the stored-event type to REFUSE a decoded event, so
   a keeper cannot accidentally persist one and I find out at compile time.
3. As a developer whose ABI changed only in how it decodes, I want the cached stream reused without
   re-fetching a block. (Already true today via ADR-0034's `reparse`; this makes it structural
   rather than a workaround, and that is the honest framing.)

## Implementation Decisions

**Core strips the decoded half, not each keeper.** `ExistingStream` is third-party-implementable with
three implementations already; putting the rule in each would let them drift. Strip on the way into
`saveNewEvents`, producing NEW OBJECTS: a new array holding the same references strips nothing, and
those references are the very objects just handed to `processor.process`.

**`reparse` widens to accept the stored type.** It is typed `readonly LogEvent<ABI>[]` and is the
SOLE consumer of what `fetchFrom` returns, so "decoding happens on read" rests on widening its
parameter. Small, but it is the seam that makes the change work.

**`lastSync`'s events are stripped too.** `LastSync.unconfirmedBlocks` holds full DECODED events, and
the STREAM keeper's stored copy is never read back as events: `promiseToLoad` takes only
`lastFromBlock`, `lastToBlock`, `latestBlock` and `context`, the live reorg window is `this.lastSync`
in memory, and `checkTxInclusion` answers from the STATE keeper's copy. So keeping them decoded would
leave the one stale thing in the stream. **The strip must build a NEW `LastSync`**, because the same
object is handed to the state keeper on the same tick and a mutating strip would silently empty the
live reorg window.

**`replayStream` stops being an `ExistingStream`.** The exclusion form forces this and it is the
right answer rather than a casualty. Nothing wires `replayStream` as `keepStream`, so they never meet
at RUNTIME, but `replayStream` DECLARES `ExistingStream` and `StreamFixture.eventStream` is
`LogEvent[]`, so narrowing the seam stops it compiling. A fixture is a decoded test INPUT; a keeper
is a store of what the node said. They have been sharing one interface because nothing made them
differ.

So the fixture gets its own reader type and its format is untouched. **And `fixture.ts`'s docstring
must be rewritten in the same change**: it currently sells `replayStream` AS the `keepStream` seam
("this is the seam the indexer already consults before fetching, so pointing it at a fixture is how a
run gets its events from disk"). Leaving that would ship documentation telling a user to do what the
types now refuse. Its one real consumer is `packages/core/test/streamFixture.test.ts`, which calls
`fetchFrom`/`saveNewEvents` structurally; the conformance workload does not use it at all.

**What this does NOT do is keep two shapes behind one interface** with an already-decoded
discriminator. That was considered and rejected: it preserves the ambiguity the type exists to
remove.

## Testing Decisions

- **The refusal is a TYPE claim and needs a type test.** Assert it under `pnpm typecheck` with
  `@ts-expect-error`, in the style of `packages/browser/test/processorKinds.test.ts`. Note the trap:
  both `keepStream` call sites in the browser tests pass the keeper through as `never`, so a
  stored-event break is INVISIBLE there — those tests passing unchanged proves nothing about the
  compile-time half.
- **Reuse across a decode change** is already pinned by `packages/browser/test/invalidation.test.ts`;
  those tests passing unchanged is the evidence that raw-only loses nothing at RUN time.
- **`fetchFrom` answers the same membership and order** for the same `fromBlock`, with the same raw
  halves. Not event-for-event equality, since it now returns raw-only where it returned decoded,
  which is the change itself.
- **The `lastSync` strip does not mutate**: the object handed to the state keeper still carries its
  unconfirmed window after a stream save.

## Out of Scope

- **Everything in `appending-to-the-stream-costs-the-batch`**: segments, `clear`, enumeration, the
  `lastSync` key, the structural migration. This spec assumes that landed.
- **The wire format.** `WireBatch` keeps shipping decoded events, since the receiving primitive takes
  them and the sender holds the ABI. Storage and wire may differ.
- **Per-segment filter or lineage provenance.**

## Further Notes

Story 3 is already delivered today by ADR-0034's unconditional `reparse`, so this spec is smaller
than it reads: its real content is the stored type, the strip, and the `replayStream` disposition.
