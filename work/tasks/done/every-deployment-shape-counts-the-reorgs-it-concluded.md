---
title: 'Every deployment shape counts the reorgs it concluded, not only the one behind an HTTP route'
slug: every-deployment-shape-counts-the-reorgs-it-concluded
promotedFrom: observation:a-run-process-counts-no-reorgs-on-status
blockedBy: []
covers: []
---

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

### The shape, DECIDED — do not re-open it

This task launched with two open questions. Both are answered, and the answers are the shape of the
work rather than background: build to them, and do not re-derive the fork.

**The counter is reported by CORE and persisted by whoever owns the store.** The reorg is already
concluded in core and already crosses the ingestion boundary as an outcome; the count becomes a
consequence of that outcome rather than something the HTTP route does. ONE writer serves both
deployment shapes, and the server route becomes a CALLER of that write rather than its owner. The
counter is a fact about the FOLD, not about the transport, which is exactly why it does not belong to
the route in either shape.

The two rejected alternatives, so they are not re-proposed: having the CLI call `recordReorg` itself
was rejected because it would make the CLI depend on `@etherfold/server` for a WRITE to a database the
CLI itself owns, and would put the same write in two places, which is the shape ADR-0042 already
caught once; leaving `run` blind and documenting it was rejected because the milestone names `run` the
default thing to reach for, and the absence-versus-contradiction ratio is what tells an operator their
RPC provider is truncating results rather than that the chain reorged (ADR-0004).

Accept the cost with open eyes: this is the largest of the three options, the ingestion outcome type
and the store seam both move, and two other commands sit on that seam. That is the decided trade.

**`build` carries the counters too, and gets the `Meta` table it currently lacks.** The one-shot
terminates at the tip, so the objection is that nobody polls `/status` on a process that has exited.
That is true and beside the point: the value is not the live poll, it is what the produced DATABASE
carries. `build` is intended to emit a publishable ARTIFACT that is later fed into another process, so
a database `build` produced must carry the same facts as one `run` produced, or the artifact silently
loses its provenance the moment it becomes an INPUT rather than an output. This settles the
interaction with `a-generation-can-be-seeded-from-a-published-artifact` in the same direction: a
database IS a publishable artifact, so the schema is a property of the ARTIFACT, not of whichever
process happens to be serving it. `build` writes its counters through the SAME single writer, and the
readme says all three shapes carry counters.

## What this is NOT

- **NOT a correctness fix.** Do not "fix" reorg handling; it works. If you find yourself changing how
  a revert is applied, you have left this task.
- **NOT a richer query layer.** `/status` is the whole query surface for this milestone and that is
  deliberate (`one-command-runs-the-whole-pipeline`). Add no endpoint.
- **NOT a change to what the counters MEAN.** Absence versus contradiction is ADR-0004's distinction
  and stays exactly as it is.
- **NOT a re-opening of the two decisions above.** If building reveals that the decided shape cannot
  work, that is a drift STOP with the reason, not a quiet switch to option (a) or (c).
- **NOT a move of the store package into `@etherfold/server`.** The server still owns no store
  package; if that posture has to change, it is a deliberate, recorded change and not a side effect.

## Acceptance criteria

- [ ] A `run` process that concludes a reorg reports it on `/status`, with the same
      absence-versus-contradiction classification an `index` process reports for the same chain.
- [ ] **Asserted as an EQUIVALENCE, not in isolation**: `packages/cli/test/equivalence.test.ts` stops
      carrying its exception and compares `/status` counters between `run` and the split shape
      directly, including through the reorg it already drives. The comment pointing at the observation
      goes with the exception it explained.
- [ ] The counter is written exactly once per concluded reorg in each shape: a combined process does
      not double-count by both concluding and receiving, and the split shape's count is unchanged.
      Assert the split shape's count is unchanged rather than assuming it.
- [ ] The write goes through ONE path: core reports the reorg outcome, the store owner persists it,
      and the ingestion route is a CALLER of that path rather than a second implementation of it. A
      test asserts there is no second site recording a reorg.
- [ ] A reorg counter failing to persist never takes down the fold or the request, exactly as
      `recordReorgSafely` already guarantees on the route — now true on every shape that counts, and
      asserted on the combined one.
- [ ] `build` writes the same `Meta` schema and the same counters, so a database it produced is
      indistinguishable from one `run` produced on this axis. Asserted on a database `build` emitted,
      not only on a live process.
- [ ] The readme says which shapes carry counters (all three) and what the two classifications mean.
- [ ] The server package's dependency posture is unchanged, or its change is deliberate and recorded:
      it still owns no store package.
- [ ] Ship a changeset for every published package whose surface changes.
- [ ] `pnpm build && pnpm typecheck && pnpm test` green.

## Blocked by

- None.

## Prompt

> Make `etherfold`'s reorg counters true of every deployment shape that concludes a reorg, not only of
> the one that receives batches over HTTP. Today `etherfold run` reverts state on a reorg correctly and
> then reports `{absence: 0, contradiction: 0}` for ever, because `recordReorg` is called from the
> ingestion route alone and a combined process never touches that route.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does
> it still match the code, the tasks in `work/tasks/done/`, and the relevant ADRs (0004 on what the two
> classifications mean, 0042 on not implementing one write in two places)? If a dependency landed
> differently, do not build on the stale premise — route to needs-attention with the discrepancy
> (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> This is an OBSERVABILITY task, not a correctness one. The fold is already correct in both shapes and
> `packages/cli/test/equivalence.test.ts` proves it: `run` and `fetch` plus `index` reach identical
> state from the same chain, reorg included. If you find yourself changing how a revert is applied, you
> have left the task.
>
> The DESIGN IS DECIDED and the body explains why; build to it rather than re-deriving it. (1) The
> reorg outcome is reported by CORE and persisted by whoever owns the store, so ONE writer serves both
> shapes and the HTTP route becomes a caller of that write rather than its owner — the counter is a
> fact about the fold, not about the transport. Do NOT have the CLI call `recordReorg` itself (it would
> depend on `@etherfold/server` for a write to a database it owns, and duplicate the write — the shape
> ADR-0042 caught once), and do NOT leave `run` blind. (2) `build` gets the `Meta` table it currently
> lacks and writes the same counters through that same single writer, because `build` emits a
> publishable ARTIFACT later fed into another process, and a database that loses its provenance when it
> becomes an input is the failure being prevented.
>
> Where to work: the ingestion outcome type and the store seam in `packages/core`, the route in
> `packages/server` as a caller, and `packages/cli` for `run` and `build`. Expect the seam to move —
> that is the accepted cost of the decision, not a sign you are off-track. Two other commands sit on
> it, so a change there is a change to them.
>
> Test at the EQUIVALENCE seam, which is the point: make `equivalence.test.ts` compare `/status`
> counters between `run` and the split shape DIRECTLY and delete the exception it currently carries
> (with the comment that explained it). Also assert the once-only property in each shape — a combined
> process must not double-count by both concluding and receiving — and assert a failing counter write
> never takes down the fold, which the route already guarantees and every shape now must.
>
> Done means: `run`, `index` and `build` agree about the reorgs they concluded, the equivalence test
> compares them with no exception, the write exists in exactly one place, and the readme says all three
> shapes carry counters.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT — in
> particular where the single writer ended up and what the ingestion outcome type became. Moving that
> seam is very likely to meet the ADR gate (hard to reverse + surprising without context + a real
> trade-off, see `work/protocol/ADR-FORMAT.md`): if it does, ALSO write it as an ADR in `docs/adr/` and
> name it in the block.

## Decisions

**1. The single writer ended up in `etherfold` (the CLI), at `packages/cli/src/reorgCounters.ts`, bound by `buildProcessor`.** The task decided "persisted by whoever owns the store", and in all three folding shapes (`run`, `build`, `index`) that is the CLI: `buildProcessor` opens the libSQL handle and constructs the `VersionedStateStore`. Alternatives considered and rejected: `@etherfold/state-store-sqlite` (a store backend must not depend on `@etherfold/core`, which it would need for `ReorgCause` — ADR-0016, and the reason ADR-0027 keeps the sync cursor opaque); keeping it in `@etherfold/server` and importing it from the CLI (explicitly forbidden by the task, and it launders a server dependency into a write to a database the CLI opened); routing it through `@etherfold/platform-nodejs` (the same laundering, one level down). Touches: `run`, `build`, `index` all now go through `buildProcessor`'s new return value, and `@etherfold/server` lost an export.

**2. The durable key names moved to `@etherfold/core` (`REORG_COUNTER_KEY`, `REORG_LAST_KEY`), not to either end.** Consequence of (1): the writer and the reader are now in different packages *by design* (a read tier owns no store and still answers `/status`), so two packages have to name one row. Core is the only package both already depend on, and the one that defines `ReorgCause`. The alternative — the CLI spelling the strings and the server spelling them again — is exactly how two ends silently stop describing the same database. Coherence check: this adds no new vocabulary; `ReorgCounters` and `RecordedReorg` are the existing server types moved, and `ReorgRecorder` is named off the existing verb `recordReorg`. Touches: `@etherfold/server`'s `readReorgCounters` and its re-exported types.

**3. `IngestionOutcome` did NOT change shape; `reorg` became REPORTED-only.** I considered making it carry whether the count landed (`{detection, recorded}`), which would ripple into the HTTP response body, `IngestionResponse`, `createHttpIngestion`, `createDirectIngestion` and the fetcher host, for no assertion that is not already available. Instead the field's contract is now documented as reported-and-never-delegated, and the "no second site" scan test enforces that no caller counts from it. What moved is the *store seam* (`buildProcessor`'s return) and the *receiver's* construction options (`StreamBuilderOptions`), not the outcome. Touches: nothing on the wire; the wire response is byte-identical.

**4. `build` applies the fixed-table schema unconditionally, and `--no-auto-setup` stays refused there with a new reason.** This is a user-visible behaviour change: a `build` against an unmigrated database now creates `Meta`. It follows from the decided requirement that a database `build` emits is a publishable artifact carrying its provenance, and `build` binds no port so nothing else would ever create it. I kept the flag REFUSED (rather than making it optional on `build`) because the flag means "somebody else migrates this at *startup*" and there is no startup to decline at; the refusal message now says that instead of reusing `NOT_SERVING_BUILD`'s "answers no queries". `run` and `index` are untouched: `--no-auto-setup` still declines the tables there, and a counter that cannot then be written is a logged miscount. Touches: the `build` row of `OWNERSHIP`/`REFUSALS` in `packages/cli/src/config.ts`, and `packages/cli/README.md`.

**5. `@etherfold/core` added as a *devDependency* of `platforms/nodejs`.** Its `serve.test.ts` used to import `recordReorg` from `@etherfold/server` to set a scenario up. Rather than re-spell the key strings in a test, it now writes the row itself using core's exported keys. Dev-only; the adapter's runtime dependency posture is unchanged.

**6. Server tests supply a host recorder (`packages/server/test/utils/hostRecorder.ts`) instead of asserting the route counts.** `@etherfold/server` cannot depend on the CLI that owns the writer, so its end-to-end "a receiver counts its reverts and `/status` reports them" tests now play the HOST, which is what a deployment does. The alternative was deleting those assertions and leaving the counting covered only at the CLI seam; keeping them costs one small test helper and preserves the coverage.
