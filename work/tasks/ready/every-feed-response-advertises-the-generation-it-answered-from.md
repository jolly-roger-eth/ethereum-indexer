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
