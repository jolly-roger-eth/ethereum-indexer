---
title: 'Every deployment shape counts the reorgs it concluded, not only the one behind an HTTP route'
slug: every-deployment-shape-counts-the-reorgs-it-concluded
promotedFrom: observation:a-run-process-counts-no-reorgs-on-status
needsAnswers: true
blockedBy: []
covers: []
---

## Open questions

> **BOTH ANSWERED 2026-09-04 by wighawag**, surfaced by the `drive-tasks` conductor after building the
> other two staged defects. The answers are recorded inline under each question below. `needsAnswers`
> is deliberately still `true`: what remains is not a decision but the RE-SCOPE those decisions imply —
> "What to build" and the acceptance criteria below still describe the three-way fork, while answer 1
> (option **b**) moves work into core and the store seam and answer 2 adds a `Meta` table to `build`.
> Re-task it against the settled shape (`to-task`), then clear the flag.

1. **Where does an operational counter get written when there is no HTTP route, and what does that
   make the CLI depend on?** `recordReorg` lives in `@etherfold/server` and is called from its
   ingestion route. A combined process concludes the same reorg in core, through
   `createDirectIngestion`, and never goes near a route. Three shapes, and the choice is not a detail:

   **(a) The CLI calls `recordReorg` itself** from its direct-ingestion path. Smallest diff. But it
   makes the CLI depend on `@etherfold/server` for a WRITE to the database it owns, and the CLI
   currently reaches the server only to START one. It also puts the same write in two places, which is
   how the fetch/replay split went wrong before (ADR-0042).

   **(b) The reorg outcome is reported by CORE and persisted by whoever owns the store.** The reorg is
   already concluded in core and already crosses the ingestion boundary as an outcome; the counter
   becomes a consequence of that outcome rather than a thing the HTTP route does. One writer, both
   shapes. But it touches the store seam and the ingestion outcome type, and the server route becomes
   a caller rather than the owner.

   **(c) Leave `run` blind and document it.** Cheapest, and defensible only if the counter is a
   split-deployment concern. It is not: the milestone calls `run` the default thing to reach for, and
   the absence-versus-contradiction ratio is what tells an operator their RPC provider is truncating
   results rather than that the chain reorged (ADR-0004).

   My recommendation is **(b)**, on the grounds that the counter is a fact about the fold and not
   about the transport, and that the equivalence tests should be able to compare `/status` between the
   two shapes rather than carrying an exception. But it is the largest of the three and it touches a
   seam two other commands sit on, so it needs a human decision rather than a builder's.

   > **ANSWER: (b).** Core reports the reorg outcome and whoever owns the store persists it, so ONE
   > writer serves both deployment shapes. The counter is a fact about the FOLD and not about the
   > transport, which is precisely why it does not belong to the HTTP route in either shape. Accepted
   > with the cost named above open-eyed: it is the largest of the three, the ingestion outcome type
   > and the store seam both move, and the server route becomes a CALLER of the write rather than its
   > owner. Option (a) is rejected for the reason given — it would make the CLI depend on
   > `@etherfold/server` for a WRITE to a database the CLI itself owns, and put the same write in two
   > places, which is the shape ADR-0042 already caught once. Option (c) is rejected because the
   > milestone names `run` the default thing to reach for, so a blind default is not defensible.
   >
   > The seam move is likely ADR-worthy on its own terms (hard to reverse, surprising without context,
   > a real trade-off): judge it when building, per `work/protocol/ADR-FORMAT.md`.

2. **What does `build` do?** The one-shot terminates at the tip and has no `Meta` table at all, so
   there is nowhere to put a counter and arguably nothing to observe: nobody polls `/status` on a
   process that has exited. Options: leave `build` uncounted and say so, or give it the same schema so
   a database it produces carries the same facts as one `run` produced. This interacts with whether a
   database is a publishable artifact (`a-generation-can-be-seeded-from-a-published-artifact`).

   > **ANSWER: give `build` the same schema, and RECORD the counters.** The framing that "nobody polls
   > `/status` on a process that has exited" is true and beside the point: the value is not in the live
   > poll, it is in what the produced DATABASE carries. `build` is intended to emit a publishable
   > ARTIFACT that is later fed into another process — the same move stratagems already makes with its
   > JSON snapshot — so a database `build` produced should carry the same facts as one `run` produced,
   > or the artifact silently loses its provenance the moment it becomes an INPUT rather than an output.
   >
   > This settles the interaction flagged above in the same direction as
   > `a-generation-can-be-seeded-from-a-published-artifact`: a database IS a publishable artifact, so
   > the schema is a property of the ARTIFACT and not of the process that happens to be serving it.
   > Concretely: `build` gets the `Meta` table, writes the counters through the SAME single writer
   > answer 1 establishes, and the readme says all three shapes carry counters.

## What to build

Make the reorg counters on `/status` true of every deployment shape that concludes a reorg, not only
of the one that receives batches over HTTP.

Today `recordReorg` (`packages/server/src/reorgs.ts`) is called from exactly one place, the ingestion
route (`packages/server/src/api/ingest.ts`, `recordReorgSafely`). A COMBINED process folds through
`createDirectIngestion` and never touches that route, so `etherfold run` **reverts state on a reorg
correctly and then reports `{absence: 0, contradiction: 0}` for ever**, while `etherfold index`
folding the identical chain reports the revert it made.

**Be precise about the severity, because it is easy to overstate.** The fold is CORRECT in both
shapes: `packages/cli/test/equivalence.test.ts` asserts that `run` and `fetch` plus `index` reach
identical state from the same chain, reorg included. Nothing is mis-indexed. What is missing is the
OBSERVABILITY, and it is missing on the shape the milestone names as the default. It is also the one
`/status` field that does not agree between the two shapes, which is why that equivalence test
compares the read tier's counters against the WRITER's rather than against `run`'s, with a comment
pointing at the observation this task was promoted from.

## What this is NOT

- **NOT a correctness fix.** Do not "fix" reorg handling; it works. If you find yourself changing how
  a revert is applied, you have left this task.
- **NOT a richer query layer.** `/status` is the whole query surface for this milestone and that is
  deliberate (`one-command-runs-the-whole-pipeline`). Add no endpoint.
- **NOT a change to what the counters MEAN.** Absence versus contradiction is ADR-0004's distinction
  and stays exactly as it is.

## Acceptance criteria

- [ ] A `run` process that concludes a reorg reports it on `/status`, with the same
      absence-versus-contradiction classification an `index` process reports for the same chain.
- [ ] **Asserted as an EQUIVALENCE, not in isolation**: `packages/cli/test/equivalence.test.ts` stops
      carrying its exception and compares `/status` counters between `run` and the split shape
      directly, including through the reorg it already drives.
- [ ] The counter is written exactly once per concluded reorg in each shape: a combined process does
      not double-count by both concluding and receiving, and the split shape's count is unchanged.
- [ ] A reorg counter failing to persist never takes down the fold or the request, exactly as
      `recordReorgSafely` already guarantees on the route.
- [ ] Whatever `build` does is DECIDED and asserted rather than left ambiguous (see open question 2),
      and the readme says which shapes carry counters.
- [ ] The server package's dependency posture is unchanged or its change is deliberate and recorded:
      it still owns no store package.
- [ ] Ship a changeset for every published package whose surface changes.
- [ ] `pnpm build && pnpm typecheck && pnpm test` green.

## Blocked by

- None mechanically, but open question 1 must be answered before this is built: the three shapes touch
  different packages and a builder cannot pick between them without a call on the CLI's dependencies.
