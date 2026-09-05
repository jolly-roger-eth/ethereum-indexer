---
title: 'A consumer follows the seq-ordered stream from an opaque cursor that is validated, not trusted'
slug: a-consumer-follows-the-seq-ordered-stream-from-a-validated-opaque-cursor
spec: indexer-server-feed
blockedBy: [the-emission-stream-table-is-created-with-every-column-it-needs]
covers: [1, 2, 5]
---

## What to build

The first view over the stored stream: the RETRACTION-AWARE feed, `seq`-ordered, that a real-time
consumer follows from a cursor it controls. `removed` entries are INCLUDED, which is the point: a
consumer can act optimistically and cancel a pending action when a reorg retracts it.

`/{indexer}/feed` serves it, resuming from a cursor the caller presents.

### The cursor, and the three rules that make it safe

- **OPAQUE.** A server-encoded string, not structured data a client parses. Otherwise its encoding
  becomes a public contract that can never change. The same call ADR-0027 made for the internal sync
  cursor.
- **It CARRIES the indexer name, the stream and the position, and the first two are VALIDATED, not
  used for routing.** The route routes; the cursor's copies exist so a MISMATCH is refused. A cursor
  minted for one indexer and presented at another is a refusal, never a re-interpretation. This is
  the read-side twin of `WireContextMismatchError`, which carries `{source, config}` in the envelope
  even though the endpoint already identifies the receiver.
- **A cursor whose STREAM is no longer the one being served is REFUSED, never silently continued.**
  `seq` positions in two streams are unrelated, so serving one at the other's number is a plausible
  wrong answer. The refusal ANSWERS with the current stream identity and the position its feed starts
  at, so a consumer can re-subscribe deliberately. It is NOT a rewind: there is no fork block,
  because the logs a filter change produces were never on the old stream at all.

**Holes in `seq` are LEGAL and the cursor semantics must permit them**, so that enabling compaction
later cannot break a consumer. Do not derive the next position by incrementing.

## What this is NOT

- **NOT the canonical gated view.** No `alive` filter and no block gate here; that is the next task.
- **NOT a rewind response.** Block-hash validation and rewinding to a fork block belong to the
  canonical view, which is the one that hides reorgs. This view SHOWS them.
- **NOT a generation check.** A generation change does not invalidate a cursor: two generations over
  one stream read the same logs in the same `seq` space. Advertising the generation is its own task.

## Acceptance criteria

- [ ] A consumer reads an ordered page from `/{indexer}/feed`, presents the returned cursor, and
      resumes exactly where it left off, with no entry repeated and none skipped.
- [ ] Retractions are DELIVERED in the stream, in `seq` order beside the entries they retract.
- [ ] The cursor is opaque: a test asserts a client cannot read a position out of it without the
      server's decoder, and nothing in the response documents its encoding.
- [ ] A cursor minted for indexer A and presented at indexer B is REFUSED, not re-interpreted.
- [ ] A cursor whose stream is no longer the one served is REFUSED, and the refusal carries the
      current stream identity plus the position its feed starts at. Asserted on the response body, so
      a consumer can act on it.
- [ ] **Holes in `seq` are tolerated**: a stream with deliberately missing `seq` values is followed
      to its end with nothing skipped and no stall. Asserted, because compaction will create holes
      later and this is what must already be true when it does.
- [ ] Ship a changeset for every published package whose surface changes.
- [ ] `pnpm build && pnpm typecheck && pnpm test` green.

## Blocked by

- `the-emission-stream-table-is-created-with-every-column-it-needs` creates the table and the `seq`
  this view reads.

## Prompt

> Build the retraction-aware FEED over the server's stored emission stream: `seq`-ordered, `removed`
> entries included, resumable from a caller-held cursor, served at `/{indexer}/feed`.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED):
> does it still match the code, `work/tasks/done/` and the ADRs (0006 on the two views and cursor
> semantics, 0027 on why a cursor is opaque)? If a premise no longer holds, route to needs-attention
> with the discrepancy rather than building on it.
>
> This is the view for a consumer that WANTS to see reorgs: it acts optimistically on a log and
> cancels the pending action when a retraction arrives. So retractions are delivered, not filtered.
>
> The cursor is the part to get right. It is OPAQUE, a server-encoded string rather than data a
> client parses, for the same reason the internal sync cursor is: an encoding a client can read
> becomes a contract that can never change. It CARRIES the indexer name, the stream and the position.
> The name and stream are VALIDATED, never used for routing: the route already routed, and those
> copies exist so that a cursor presented at the wrong indexer, or against a stream that is no longer
> served, is REFUSED rather than answered. A `seq` in one stream means nothing in another, so serving
> across them is the plausible-wrong-answer class this repo refuses everywhere.
>
> Say what the stream-mismatch refusal ANSWERS with, because a consumer needs to act on it and you
> must not invent it: the current stream identity plus the position its feed starts at, so the
> consumer can re-subscribe deliberately. It is explicitly NOT a rewind, because there is no fork
> block: the logs a filter change produces were never on the old stream.
>
> Holes in `seq` must be legal. A later task adds compaction, which creates them, and a consumer that
> derives its next position by incrementing would break the day it is enabled. Build and TEST for
> holes now.
>
> Where to work: the server's route and feed modules, over the emission table the previous task
> created.
>
> Done means: a consumer follows the stream across pages with nothing skipped or repeated,
> retractions arrive, a foreign or stale-stream cursor is refused with a body that says what to do,
> and a stream with holes is followed to its end.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT, in
> particular the cursor's encoding and the page-size rule.
