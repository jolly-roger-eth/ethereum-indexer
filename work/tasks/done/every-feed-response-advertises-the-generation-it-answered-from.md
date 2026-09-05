---
title: 'Every feed response advertises the generation it was answered from'
slug: every-feed-response-advertises-the-generation-it-answered-from
spec: indexer-server-feed
blockedBy: [a-consumer-follows-the-seq-ordered-stream-from-a-validated-opaque-cursor]
covers: []
---

## What to build

Report, on EVERY feed response, the identity of the generation that answered it, as a plain readable
field. The cursor is opaque, so this field is the only thing a consumer can compare across polls to
notice that the fold behind the feed changed.

At this spec's scope the value is ADR-0006's state key, `{source, config, processor}`. Both halves
are already in hand at the write site: the resolved wire context, and `getVersionHash()`, which the
stream builder already reads on every call. It is OPAQUE, reported and compared and never parsed, so
the composition can later be replaced by the stream-digest-plus-processor-hash identity without
touching any consumer.

### Why advertise something no cursor checks

A `seq` is a position in a STREAM. A promotion to a generation over the SAME stream therefore leaves
every consumer cursor valid, and a promotion to a generation on a DIFFERENT stream is already caught
as a refusal by the cursor's stream component. What advertising buys is the case in between: SAME
logs, DIFFERENT fold. No cursor check can see it, and a consumer reading state alongside the feed
needs to be told.

**The platform ADVERTISES and does not DICTATE.** Pausing, re-scanning, or carrying on are all
legitimate and depend on what the consumer's actions mean: a notifier that already fired cannot
unfire, and only it knows that. Do not add a rule about what a consumer must do. (For the record and
not as a platform rule, the expected behaviour is to pause on a change and let the operator decide.)

## What this is NOT

- **NOT a generation column on the log table.** The logs are identical across a processor change, and
  keeping the generation out of the table is what makes that change free. This is a response field.
- **NOT cursor validation.** A generation change must NOT invalidate a cursor.
- **NOT the multi-generation model.** At this scope each named indexer has exactly one generation,
  canonical by construction. The pointer row and promotion arrive with the sibling spec, and this
  contract is shaped so that arrival changes the ANSWER and not the SHAPE.

## Acceptance criteria

- [ ] Every response from both feed views carries the generation identity as a plain readable field.
- [ ] The value is stable across polls while nothing changes, so a consumer comparing it sees no
      false positives.
- [ ] Changing the PROCESSOR changes the advertised value while leaving every cursor valid and the
      delivered logs identical. Asserted together, because that pairing is the whole point.
- [ ] The field is opaque: a test asserts nothing parses it or depends on its composition, so it can
      be replaced later without a consumer noticing.
- [ ] No generation column is added to the log table, asserted.
- [ ] Ship a changeset for every published package whose surface changes.
- [ ] `pnpm build && pnpm typecheck && pnpm test` green.

## Blocked by

- `a-consumer-follows-the-seq-ordered-stream-from-a-validated-opaque-cursor` builds the feed
  responses this field is added to.

## Prompt

> Add the GENERATION IDENTITY to every feed response the server returns, as a plain readable field.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does
> it still match the code, `work/tasks/done/` and ADR-0006 (which keys the stream on source plus
> config and the state on source plus config plus processor)? If a premise no longer holds, route to
> needs-attention.
>
> The reasoning matters more than the field. A `seq` is a position in a STREAM, so a promotion to a
> generation over the same stream leaves every cursor valid, and one to a generation on a different
> stream is already refused by the cursor's stream component. The case in between is SAME logs,
> DIFFERENT fold: no cursor check can detect it, and a consumer whose actions depend on the state
> needs to know. Since the cursor is opaque, a readable field is the only thing it can compare across
> polls.
>
> The value at this scope is `{source, config, processor}`, and both halves are already at hand where
> the response is built: the resolved wire context, and the processor version hash the stream builder
> already reads on every call. Treat it as OPAQUE, reported and compared but never parsed, so its
> composition can be swapped later without touching a consumer.
>
> The platform ADVERTISES and does not DICTATE. Do not add a rule about what a consumer should do on
> a change; pausing, re-scanning and carrying on are all legitimate, and only the consumer knows
> whether its actions can be undone.
>
> Do NOT add a generation column to the log table. The logs are identical across a processor change,
> and keeping the generation out of the table is exactly what makes that change free for a feed
> consumer.
>
> Done means: both views advertise it, the value moves when the processor changes while cursors stay
> valid and logs stay identical, and nothing anywhere parses the value.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT.

## Decisions

**The advertised value is composed from `GenerationId` (`{streamDigest, processorVersionHash}`), not from ADR-0006's `{source, config, processor}` wire context.** The task's snapshot named the wire context and said the composition "can later be replaced by the stream-digest-plus-processor-hash identity"; that replacement already exists and is the repo's word for this concept (`GenerationId`, `CONTEXT.md`'s **generation**: "identified by its STREAM plus the processor's `version` hash"). Building the older composition and swapping it later would have meant keying an identity on the wire context's 32-bit `simple_hash` source halves, which ADR-0034 rules out as a key. Alternative considered: build `{source, config, processor}` literally as written and swap later, rejected as paying twice for a value the criteria declare opaque. **Touches** nothing outside this task by construction (opacity), but it settles which concept the word `generation` names on the wire.

**It is rendered as an OPAQUE digest, not as a structured `{stream, processor}` object nor a delimited string.** A consumer handed two named fields will read one of them, and a consumer handed `a-b` will split it; either makes the composition a contract by the back door, which is the exact failure `feed/cursor.ts` argues against for the cursor and the thing "replaceable later" needs to survive. Alternatives: the structured object (more diagnosable, rejected because it makes criterion 4 a promise the shape invites breaking) and a concatenation (same objection, no upside over the object). Cost, accepted: an operator cannot read the processor version out of the value; the response still carries `stream` beside it, and the server knows the preimage. **Touches** any future runtime that advertises a generation (browser/CLI) — the rendering lives in core so there is one, and the glossary now says so.

**Every response *that resolved a named indexer* carries it; `501 ingestion-not-configured` and `404 unknown-indexer` do not.** Those two come from the shared `resolveIndexer` before any entry exists, so there is no generation that answered — a host with no registry, or a name it was not built with. Alternative: put a placeholder on them, rejected as inventing an identity for an answer no fold gave. The refusals that *do* carry it (four cursor mismatches, `invalid-limit`, `invalid-gate`, `409 rewind-required`) do so because a refusal is still an answer this fold gave. **Touches** `a-named-indexer-is-a-route-segment-and-a-registry-entry`'s shared resolver (unchanged by me) and any consumer error handling.

**`LogIngestion` gains `generation: GenerationId` rather than a bare `processorVersionHash`, and it is derived per read.** The composition rule then lives once in core instead of the server assembling an identity from two fields; the `stream` half is derived from `streamDigest` so it is not a second copy that can disagree. Derived rather than snapshotted because `getVersionHash()` covers a processor's configuration and `configure()` can move it after construction, so a captured field could advertise a fold that is no longer running. This is a required member on a published interface: `StreamBuilder` supplies it, and the two in-repo test fakes (`core/test/directIngestion.test.ts`, `platforms/nodejs/test/serve.test.ts`) were updated. **Touches** every implementer of `LogIngestion` and `the-server-and-cli-hold-generations-too`, where one entry holds several generations — this reads as "which generation this receiver is", which stays true when an entry holds several receivers.

**`streamIdentity.test.ts`'s "is the ONLY digest of its kind" now allows `generation/identity.ts`, rather than extracting a shared hashing helper.** That test guards against a *second implementation of the stream digest* (two that must agree byte-for-byte would address one stream twice); a digest of a different value, built on top of the stream digest, is not that. Alternative considered and rejected: factor the `sha256(stringToHex(canonical_form(x))).slice(2, 34)` rendering into `utils/hash.ts` so there is literally one hashing site — it would have touched the derivation of a persisted key for cosmetic gain, and would have weakened the deliberate in-file assertions on `stream/identity.ts`. The new file is asserted to keep the same discipline (sync, no `crypto.subtle`, no `simple_hash`) in `generationIdentity.test.ts`. **Touches** `a-stream-is-identified-by-the-digest-of-its-filter`'s invariant, which is narrowed in wording, not in force.

**No ADR, and ADR-0006's `status: accepted, not yet implemented` is left alone.** The composition choice fails the ADR gate's "hard to reverse" leg on purpose — opacity plus a test that nothing depends on the composition is what makes it reversible — so the JSDoc, the changeset and this block carry the rationale. The status line stays for the reason the previous task recorded: `ADR-FORMAT.md` enumerates no partly-implemented value and the last of the six tasks should flip it; `pair-compaction-is-off-by-default` remains.
