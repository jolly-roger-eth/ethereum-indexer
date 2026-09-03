# A `run` (or `build`) process counts no reorgs on `/status`

2026-09-03, noticed while building `index-receives-a-pushed-stream-and-owns-the-database`.

`recordReorg` (`packages/server/src/reorgs.ts`) is called from exactly one place, the HTTP ingestion route (`packages/server/src/api/ingest.ts`, `recordReorgSafely`). A COMBINED process folds through `createDirectIngestion` and never touches that route, so `etherfold run` reverts state on a reorg and reports `reorgs: {absence: 0, contradiction: 0}` on `/status` for ever, while `etherfold index` folding the identical chain reports the revert it made. `build` has no `Meta` table at all.

That matters because the absence-versus-contradiction rate is the signal that says "your logs are being truncated" rather than "the chain reorged" (ADR-0004, `CONTEXT.md` under **reorg cause**), and it is silently unavailable on the deployment shape the milestone calls the default. It is also the one `/status` field that does NOT agree between the two deployment shapes: `packages/cli/test/equivalence.test.ts` therefore compares the read tier's counters with the WRITER's rather than with `run`'s, and says why.

Not fixed here: where an operational counter gets written when there is no HTTP route (and whether the CLI should therefore depend on `@etherfold/server`, and what `build` does with no fixed-table schema) is a design question touching two other commands, not a detail of this task.
