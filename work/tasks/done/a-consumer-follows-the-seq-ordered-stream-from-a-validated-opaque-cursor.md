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

## Decisions

**The cursor's encoding: a checksummed, per-payload-scrambled base64url framing of a small JSON envelope, and it is honestly labelled as obfuscation.** `fnv1a32` over the JSON payload, an xorshift32 keystream seeded from that checksum, the checksum prefixed in clear, the whole thing base64url with no padding. It is deterministic (the same position always yields the same cursor) and self-checking (an edited cursor fails the checksum and becomes `400 invalid-cursor` instead of decoding to some other position). Alternatives considered: **plain base64url of JSON**, rejected because a client can read it in one line and the acceptance criterion is precisely that it cannot, which is not pedantry (a readable number is what gets incremented, and holes make incrementing wrong); **an HMAC**, rejected because there is no key to hand (the only secret here is `INGEST_TOKEN`, which is the fetcher's write credential and must not become a read-path dependency), and because tamper-*proofing* is not the property needed; **server-stored cursors**, rejected as state about a consumer, which ADR-0005 says etherfold does not keep. The JSDoc says plainly that this is not encryption and not a signature: a determined client that reimplements the file can read one. What it stops is *accidental* dependence on the format, which is the failure that actually happens. **Touches** the canonical-view task, which shares this codec.

**The page-size rule: `limit` defaults to 100, is capped at 1000, and a larger one is REFUSED (`400 invalid-limit`, carrying `maxLimit`) rather than clamped.** A clamp is accept-and-ignore, and it is the dangerous kind: the caller's only check is the count it got back, and a clamped page is indistinguishable from "that is all there was". Non-integers, zero and negatives are refused for the same reason. Alternative considered: silent clamping (the common REST convention), rejected against the repo's standing "refuse rather than accept-and-ignore" stance. **Touches** the canonical view, which should use the same bound and the same refusal.

**The cursor carries a VIEW discriminator, which the task did not name.** The task said "name, stream, position". I added `view` because the two views count in different spaces (`seq` here, `(blockNumber, logIndex)` there) and the next task shares this codec, so without it a canonical cursor presented at `/feed` would either be read as a `seq` (the plausible-wrong-answer class this repo refuses everywhere) or collapse into a vague "invalid cursor". It is `400 view-mismatch`, and it makes the canonical view's cursor an *added field* rather than a re-mint. The word `view` is ADR-0006's and the spec's own ("two views over it"), not a new concept. **Touches** the canonical-view task directly.

**The stream-mismatch refusal answers `{stream, startCursor}`, and the field is named `startCursor` rather than `cursor`.** `stream` is the current stream digest (readable, comparable); `startCursor` is an opaque cursor at the position the current stream's feed begins at. Expressing the position as a *cursor* is forced: positions are otherwise not a vocabulary the consumer has. It is deliberately not called `cursor`, which in a success response means "present this next" and would invite a client to auto-follow the refusal; the task is explicit that re-subscribing is deliberate, and that this is **not** a rewind (asserted: the body's keys are exactly `error, message, startCursor, stream, success`, and it carries no fork block). **Touches** the canonical view, whose rewind response is a different shape for a different reason and should not reuse this name.

**All four cursor refusals are `400`, never `409`.** On the ingest side `409` is the ONE resumable refusal (re-send from `expectedFromBlock`, ADR-0004). None of these is resumable by re-presenting the same cursor, and re-meaning `409` on the read side would make a sender's and a consumer's contract say different things with one number. **Touches** the ingest contract by leaving it alone.

**`indexer-mismatch` names the indexer the caller ADDRESSED and never the one the cursor was minted at** (asserted: the refusal body contains no trace of the other tenant's name). Echoing it would both confirm that the encoding carries a name and hand one tenant's name to a caller poking at another.

**The feed is a PUBLIC read and is not behind `INGEST_TOKEN`.** That token is the fetcher's deployment secret guarding the routes that can WRITE; putting the feed behind it would mean issuing every consumer the credential that moves the cursor. A consumer is a third party built outside etherfold (ADR-0005). Alternative considered: a second read token, rejected as a new configuration surface and a new refusal for a milestone whose whole query surface is otherwise anonymous (`/status`). A deployment that needs a private feed puts it behind its own edge. **Touches** any later authorisation work, and `CONTEXT.md`'s "the QUERY LAYER is deferred" note.

**The feed requires `getIndexer`, so `etherfold serve` (the read tier) does not serve it today.** Validating a cursor's stream means knowing which stream is served, and only the registered receiver knows (`LogIngestion.streamDigest`). The table cannot answer it: one indexer's rows may span several streams over its life, nothing in them says which is current, and choosing by heuristic (for example "the only one present") is exactly the plausible wrong answer the discriminators exist to prevent. So the feed reuses the ingest resolver and a host with no registry gets `501`. I kept the existing error code `ingestion-not-configured` for that case rather than forking a second code for one condition, and generalised its message to "this server hosts no named indexer" (the code is pinned by tests in server, cli and platforms; the message is not). **Touches** `serve`, which refuses `--indexer` and therefore has no name to register: giving the read tier a feed is a separate task, and the honest options are a served-stream config or the canonical-pointer row the generation spec owns. Alternative considered: deriving the current stream from the table, rejected above.

**The response advertises `stream` on the success path too, not only on the refusal.** Symmetry, and a consumer that re-subscribed after a `stream-mismatch` can confirm where it landed. Noting the adjacent-concept hazard explicitly, in the code and the README: the stream identity says WHICH LOGS (`{source, config}`); it is **not** the generation identity (`{source, config, processor}`) that `every-feed-response-advertises-the-generation-it-answered-from` adds, which says WHICH FOLD. A consumer comparing `stream` across polls will not see a processor change. **Touches** that sibling task, which adds a second identity field beside this one.

**No `seq` and no `alive` on an entry, and no `seq` anywhere in the response** (asserted on the body text with the cursor removed, and on the exact key sets). Publishing the position is how a consumer ends up incrementing it, which holes make wrong; `alive` is the other view's derived flag and a retraction-aware consumer learns the same fact from the retraction arriving. **Touches** any later consumer-facing documentation.

**The cursor codec is NOT exported from the package index** (only the `FeedEntry` type is). Publishing a decoder would make the encoding a contract by the back door, which is what opacity exists to prevent; tests import the module path directly, as they already do for `schema.js` and `api/status.js`.

**`ADR-0006`'s `status: accepted, not yet implemented` is left alone**, on the previous task's recorded reasoning: `ADR-FORMAT.md` enumerates the legal statuses with no partly-implemented value, and the last of the six tasks should flip it.
