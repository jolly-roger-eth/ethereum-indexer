---
title: 'The canonical view is gated by the caller and tells a reorged consumer to rewind'
slug: the-canonical-view-is-gated-and-rewinds-on-a-reorg
spec: indexer-server-feed
blockedBy: [a-consumer-follows-the-seq-ordered-stream-from-a-validated-opaque-cursor]
covers: [3, 4]
---

## What to build

The second view: the one a SIMPLE consumer follows so it never implements reorg handling at all. It
serves only `alive` entries, bounded by a block gate the CALLER supplies, ordered by block number and
log index. A consumer's whole sync state is one advancing position.

Because it hides reorgs, it owes the consumer the one thing hiding them can break: **the cursor is
validated against the block hash the consumer last saw**, and a cursor whose block is no longer
canonical answers REWIND TO FORK BLOCK F rather than silently skipping the events the consumer never
received.

There is a proof worth holding while building it: a reorg invalidates a CONTIGUOUS SUFFIX, so
validating the single block at the cursor certifies the whole prefix behind it. One hash check is
enough; walking back over the window is not needed.

The gate is the caller's, not the server's. A consumer that only wants final data passes a low gate;
one that wants the tip passes a high one. The server does not decide the consumer's risk appetite.

## What this is NOT

- **NOT a second cursor codec.** It extends the opaque cursor the previous task built (name, stream,
  position) with the block hash this view validates. One codec, one refusal path.
- **NOT retraction delivery.** This view exists so a consumer never sees one; a reorg reaches it as a
  rewind instruction, not as `removed` entries.
- **NOT a server-chosen gate.** Do not default the gate to finality or to the tip on the consumer's
  behalf; it is supplied per request.

## Acceptance criteria

- [ ] The view serves only `alive` entries, ordered by block number then log index, and never
      includes a retraction.
- [ ] The caller's block gate bounds it: an entry above the gate is not served, and raising the gate
      on a later call serves it.
- [ ] A consumer follows it across pages with one advancing position and no reorg handling of its
      own, landing on the same set a from-scratch read of the same gate returns.
- [ ] **A cursor whose block is no longer canonical answers rewind-to-fork-block F**, with F
      identified, rather than skipping the events between. Asserted against a real reorg through the
      ingest path, not a synthesised row edit.
- [ ] The events the consumer had not yet received are delivered after it rewinds, so nothing is
      lost across the reorg.
- [ ] One cursor codec is shared with the `seq` stream: a test asserts there is no second encoder,
      and the name/stream mismatch refusals still behave as that task specified.
- [ ] Ship a changeset for every published package whose surface changes.
- [ ] `pnpm build && pnpm typecheck && pnpm test` green.

## Blocked by

- `a-consumer-follows-the-seq-ordered-stream-from-a-validated-opaque-cursor` builds the feed route
  and the opaque cursor this view extends and shares.

## Prompt

> Build the CANONICAL view over the server's stored emission stream: `alive` entries only, bounded by
> a caller-supplied block gate, ordered by block number and log index. This is the view for a
> consumer that never wants to handle a reorg, so its entire sync state is one advancing position.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does
> it still match the code, `work/tasks/done/` and the ADRs (0006 on the two views and the block-hash
> cursor validation, 0015 on an unresolvable block address being an error rather than an empty
> result)? If a premise no longer holds, route to needs-attention with the discrepancy.
>
> Because this view HIDES reorgs, it owes the consumer the compensating guarantee: validate the
> cursor against the block hash the consumer last saw, and when that block is no longer canonical,
> answer REWIND TO FORK BLOCK F. Silently continuing would skip exactly the events the consumer never
> received, which is the failure this validation exists to prevent.
>
> A proof that keeps the implementation cheap: a reorg invalidates a CONTIGUOUS SUFFIX of the chain,
> so validating the single block at the cursor certifies the whole prefix behind it. You do not need
> to walk the window.
>
> The block gate is the CALLER's. Do not default it to the tip or to finality on the consumer's
> behalf: a consumer that only wants final data passes a low gate, and one that wants the tip passes a
> high one. The server does not decide a consumer's risk appetite.
>
> Extend the OPAQUE cursor the previous task built rather than adding a second codec. It already
> carries the indexer name, the stream and the position, and already refuses a foreign or stale-stream
> cursor; this view adds the block hash it validates. One codec and one refusal path, or the two views
> will drift.
>
> Where to work: the server's feed modules, over the emission table and beside the `seq` view.
>
> Done means: the gated view serves only live entries in block and log-index order, a real reorg
> driven through the ingest path produces a rewind instruction naming the fork block, the consumer
> receives everything after it rewinds, and there is exactly one cursor encoder.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT, in
> particular the rewind response shape and how the fork block is identified.
