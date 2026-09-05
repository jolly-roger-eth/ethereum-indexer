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

## Decisions

**The route is `GET /{indexer}/canonical`, a sibling path rather than `?view=canonical` on `/feed`.** The two views take different parameters (a `gate`, here and nowhere else), answer different refusals (a REWIND here and never there) and hand back different entry shapes, so one path per contract keeps each surface's parameters and refusals true of the whole path. Alternatives: `?view=` on `/feed`, rejected because half the query string would be meaningful only for one value of it, and the `501`/`404`/`limit` answers would have to be documented conditionally; `/{indexer}/feed/canonical`, rejected because nesting implies a sub-resource of the seq stream, and it is a sibling view over the same table, not a slice of that one. The glossary's own words are "the retraction-aware feed" and "the canonical view", so the segment matches the concept. **Touches** `every-feed-response-advertises-the-generation-it-answered-from`, which must add its field to two routes.

**The rewind is `409 rewind-required`, carrying `{stream, forkBlock, rewindCursor, message}`, and `409` is deliberate.** ADR-0004 already makes `409` the ONE resumable refusal in this system ("your position is not where mine is, carry on from here"), and a rewind is that same sentence spoken to a consumer, so using the same number for the same meaning is what keeps a sender's and a consumer's contract legible together. The previous task decided all four *cursor mismatch* refusals are `400` precisely because none of them is resumable; this one is, so it is the exception and not a contradiction — those four are unchanged. Alternatives: `400` beside the mismatches, rejected because it files a correction the caller is MEANT to follow among ones it must not; `200` with an empty page and a rewind field, rejected outright because a consumer that ignores an unknown field reads it as "caught up", which is the silent skip in a new costume. `rewindCursor` is named to say "present this next", deliberately unlike the stream mismatch's `startCursor`, which the previous task named to *discourage* auto-following; here auto-following is the correct behaviour, because this view's whole promise is that the consumer implements no reorg handling. **Touches** `createHttpIngestion`'s reading of status codes only by staying on the read side (that client never calls these routes), and any future consumer SDK.

**The fork block is the LOWEST block the stream has retracted anything at SINCE the cursor was minted — and to make that answerable the canonical cursor carries a `since` mark beside its position and hash.** The mark is the stream's `seq` high-water mark when the cursor was handed out. Why a mark is needed at all: only `seq` records TIME in that table, and the fork is exactly "what changed after you last looked"; the cursor's own block cannot answer it, because a reorg can fork BELOW the cursor and answering the cursor's block is the silent skip this validation exists to prevent. Taking the MINIMUM over several retractions is correct rather than approximate — a second, deeper reorg must move the answer DOWN — and there is a test for it. Alternatives: **look the mark up from the cursor's own row** instead of carrying it, rejected because pair-compaction (the sibling ready task) reclaims a dead row together with its retraction, which is exactly the row that lookup depends on; **walking back over the window**, unnecessary by ADR-0006's contiguous-suffix proof. **The coherence risk, named**: ADR-0006 says "a synthetic sequence is wrong for the canonical view", and it is — as an ORDER. `since` is not a position, never advances the read and never appears outside the opaque envelope; the JSDoc at the field says so in those words. **Touches** `pair-compaction-is-off-by-default`, whose "answer-preserving for the canonical view" property this design deliberately survives (`isStillCanonical` asks "is it alive", so a compacted pair and a flagged-dead row give the same answer).

**`gate` is REQUIRED, and absent or malformed is a new `400 invalid-gate`.** "Do not default it" means the only honest treatment of an absent gate is a refusal: serving unbounded would be defaulting to the tip, which is the specific thing forbidden. Every candidate default is wrong for somebody and none of them says so. ONE error code covers absent and malformed, with the message distinguishing them, following `invalid-limit`'s precedent of one code per parameter. **Touches** any consumer-facing documentation and ADR-0007's two lanes (a `safe` consumer passes a low gate, a `fast` one a high one).

**A canonical entry carries no `removed` field at all** (new exported `CanonicalEntry`, beside `FeedEntry`). A flag that is `false` on every entry a view can ever serve invites `if (entry.removed)` handling that can never fire, which is exactly the reorg handling this view exists to remove from a consumer. Alternative: `removed: false` on every entry, for one entry type across both views; rejected on that ground. **Touches** the package's public types.

**Three refactors inside the fence, each to avoid a second copy of something the acceptance criteria require to be single.** (1) The row shape and mapper moved to `feed/entries.ts`, so `FeedEntry` is now exported from there rather than `feed/stream.js` (internal path only; the package export name is unchanged). (2) `refuse` is parameterised by the served view and its start position instead of hard-coding the seq view — one refusal mapper for both, which is the same argument as one codec. (3) The test fixture (`deploy` / `post` / `batchOf` / `transfer`) moved to `test/utils/feedHarness.ts`, so both suites drive reorgs through the same real ingest path rather than each defining its own idea of one. `feed.test.ts`'s 23 tests are unchanged and still pass.

**`ADR-0006`'s `status: accepted, not yet implemented` is left alone**, on the previous task's recorded reasoning: `ADR-FORMAT.md` enumerates no partly-implemented value, and the last of the six tasks should flip it. Two remain.
