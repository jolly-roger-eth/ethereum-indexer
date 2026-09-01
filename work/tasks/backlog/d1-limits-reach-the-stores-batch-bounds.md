---
title: "D1's per-request limits reach the store's batch bounds, instead of a default that is 5x over"
slug: d1-limits-reach-the-stores-batch-bounds
spec: historical-state-database
blockedBy: [index-to-a-store-from-the-cli]
covers: [6]
---

## What to build

A Worker deployment must run the versioned-row store against D1 **within D1's real per-request
limits**, with those limits expressed as HOST CONFIGURATION rather than as constants in shared code.

This is the one undelivered piece of `server-platform-adapters` (now in `work/tasks/cancelled/`,
whose other six criteria were delivered by `agnostic-server-skeleton`). It is re-minted as a forward
task because it has since acquired something that task only assumed: a MEASURED reason.

### The defect, which is concrete and currently shipping

`work/notes/findings/d1-caps-bound-parameters-per-query-at-100.md` records D1's documented limits.
Two of the three `BatchBounds` defaults are wrong for D1:

- **`maxRowsPerStatement: 500` against D1's cap of 100 BOUND PARAMETERS PER QUERY.** Five times over.
  `dropVersionsStatement` (`packages/state-store-sqlite/src/statements.ts:269-274`) emits one `?` per
  row id, and `prune` (`src/store.ts:323`) fills it with up to that many. So **retention enforcement
  is broken on D1 under the shipped default** — and it passes on every other backend, which is the
  shape that runs locally and fails only in production.
- **`maxStatementsPerBatch: 100` against 50 queries per Worker invocation on the FREE plan** (1,000
  on Paid, where it is fine).

And `batching.ts`'s own docstring claims `DEFAULT_BATCH_BOUNDS` is "deliberately conservative: small
enough to fit inside the tightest hosted limits we are aware of, so that the default never surprises
anyone in production". That sentence is false for D1, which is the backend the Worker host exists to
serve. **Correcting it is in scope**; a comment asserting a safety property the numbers do not have is
worse than no comment.

### Where the limits must live, and where they must not

`BatchBounds` is already parameterised and `VersionedStateStore` already takes `{bounds}`
(`src/store.ts:64-65,133`), so **no new seam is needed in the store**. What is missing is that
**nothing anywhere passes bounds** — the only readers of `BatchBounds` are the store itself and its
own tests. The Worker host supplies `{getDB, getEnv}` and no store at all today.

- **D1's numbers belong in `platforms/cf-worker`**, the only place a runtime is named (ADR-0003).
- **They must NOT become constants in `@etherfold/state-store-sqlite`.** That package targets the
  `remote-sql` interface, and a hosted backend is one backend among several rather than the thing
  being built for. This is the rule the cancelled task stated and it still governs.
- The DEFAULT may still change (see the criteria): making the shipped default honest is a different
  act from letting a host state its own limits, and both are wanted.

### Why it was blocked, and what unblocks it

`agnostic-server-skeleton` deliberately gave `@etherfold/server` NO store dependency, so there was no
path from an adapter's configuration to the store's bounds. `work/specs/ready/one-command-runs-the-whole-pipeline.md`
is what creates that path: `run` is the first thing that wires a store into a server process, and
that spec says so explicitly while disclaiming this task ("it is not this spec's to deliver").
`index-to-a-store-from-the-cli` is the nearest real prerequisite and is in `work/tasks/ready/`.

**Confirm the seam exists before building.** If a store still cannot be reached from a host's
configuration when you claim this, that is drift: stop and surface it rather than inventing a seam,
because inventing one here would pre-empt the `run` design.

### Watch the file overlap

`work/specs/ready/one-command-runs-the-whole-pipeline.md` has a named exception that also lands in
`platforms/nodejs/src` (`startServer` growing an option that accepts an existing `RemoteSQL`). If
that has not landed when you claim this, expect to rebase; if it has, build on it rather than
around it.

## Acceptance criteria

- [ ] D1's per-request limits are expressed as CONFIGURATION in `platforms/cf-worker` and reach the
      store's `BatchBounds`, with no provider constant added to `@etherfold/state-store-sqlite` or to
      any other shared package.
- [ ] **A prune on D1 issues no query with more than 100 bound parameters**, asserted rather than
      assumed. This is the defect that motivates the task, so it gets the test: drive a prune whose
      budget exceeds the bound and assert the parameter count of every emitted statement, at the
      statement seam rather than through the network.
- [ ] The `maxStatementsPerBatch` value a Worker deployment uses is correct for its PLAN, and which
      plan it assumes is stated rather than implied (the Free and Paid caps differ by 20x).
- [ ] **The shipped `DEFAULT_BATCH_BOUNDS` and its docstring are reconciled with the finding.**
      Either lower `maxRowsPerStatement` so the "fits inside the tightest hosted limits" claim
      becomes true, or narrow the claim to name the engine it is true of. Say which you chose and why
      in `## Decisions`; do not leave a comment asserting a property the numbers lack.
- [ ] `packages/state-store-sqlite/test/batch.test.ts` pins the defaults by value
      (`maxStatementsPerBatch` 100, `maxBytesPerBatch` 90_000) and must be updated DELIBERATELY if a
      default moves, still asserting what it was written to assert.
- [ ] The Worker adapter's existing tests still pass under `@cloudflare/vitest-pool-workers`, and
      `wrangler deploy --dry-run` still succeeds.
- [ ] A changeset for every published package whose surface changed (a changed DEFAULT is a
      behaviour change to `@etherfold/state-store-sqlite` and needs one even though nothing is
      published yet).
- [ ] `pnpm build && pnpm typecheck && pnpm test` green.

## Blocked by

- `index-to-a-store-from-the-cli` — the nearest real edge onto the work that first wires a store into
  a server process. Without it there is no path from host configuration to the store's bounds, which
  is precisely why the predecessor task sat unclaimable for months.

## Prompt

> Make a Cloudflare Worker deployment run the versioned-row state store inside D1's real per-request
> limits, in the `etherfold` monorepo, with those limits stated by the HOST rather than baked into
> shared code.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED). Two
> things specifically. (1) Re-fetch D1's limits: `work/notes/findings/d1-caps-bound-parameters-per-query-at-100.md`
> records them with a dated source, and they are per-plan and revised by Cloudflare, so treat the
> finding as correctable rather than as fact. If they have moved, update the finding in the same
> change. (2) Confirm a store can actually be reached from a host's configuration; the predecessor
> task was blocked for exactly that reason. If it cannot, do NOT invent the seam — route to
> needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal"),
> because inventing one pre-empts the `run` design in `work/specs/ready/one-command-runs-the-whole-pipeline.md`.
>
> **The code that exists is EVIDENCE, not authority.** Nothing is published (`CONTEXT.md`), so a
> changed default costs a changeset and not a migration. If a shape is in your way, refactor it.
>
> **Where to look.** `packages/state-store-sqlite/src/batching.ts` is `BatchBounds`,
> `DEFAULT_BATCH_BOUNDS` and `planBatches`; `src/store.ts` takes `{bounds}` and applies
> `maxRowsPerStatement` in `prune`; `src/statements.ts` is `dropVersionsStatement`, the one statement
> whose bound-parameter count scales with a list. `platforms/cf-worker/src/worker.ts` is the Worker
> host (`{getDB, getEnv}`, `RemoteD1`) and `src/env.ts` its bindings. `packages/server/src/types.ts`
> is `ServerOptions`, which deliberately has no store.
>
> **Domain vocabulary.** *Batch bounds* are per-REQUEST limits of a remote backend, configuration and
> never constants. They are unrelated to *retention* (a distance in BLOCK NUMBERS, ADR-0019) and to
> the *generation caps* (a COUNT), even though a prune is where all three meet: retention decides
> WHICH versions may go, `prune` is the host-scheduled call that drops them (ADR-0022), and the batch
> bounds decide how many may be named in one statement.
>
> **Easy to get wrong:**
>
> - Putting D1's numbers in `@etherfold/state-store-sqlite`. That package targets `remote-sql`; D1 is
>   one backend among several, and a provider constant in shared code is the thing this task exists
>   to avoid.
> - Testing the parameter count through the network. Assert it at the statement seam, where you can
>   count `args` per statement; a D1 rejection in an integration test tells you it broke, not where.
> - Treating `maxBytesPerBatch` as the answer to D1's 100 KB cap. That cap is per STATEMENT and this
>   bound is per BATCH; they are different quantities that happen not to collide today.
> - Assuming the Free and Paid plans are interchangeable. `maxStatementsPerBatch` is fine on Paid and
>   2x over on Free.
> - Note for the tests: `@cloudflare/vitest-pool-workers` v0.22 removed the `./config` entry point and
>   `defineWorkersConfig`; the pool is now a Vite plugin, `cloudflareTest(...)`. The house template
>   still shows the old form because it is pinned to an older vitest.
>
> **Scope fence.** Do NOT rebuild the host adapters — both exist and are verified, under
> `agnostic-server-skeleton`. Do NOT design the store-into-server seam; consume the one `run` creates.
> Do NOT change what `prune` MEANS (ADR-0022: it is an explicit call the host schedules, never a side
> effect of a write) or what retention is measured in (ADR-0019).
>
> Done means: a Worker deployment prunes and writes against D1 without exceeding a documented D1
> limit, the numbers live in the adapter, and the shipped default no longer claims a safety it does
> not have.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT (how
> the adapter's limits reach the store; whether you lowered the default or narrowed its docstring, and
> why; which D1 plan the adapter assumes and how a deployment on the other one is meant to change it).
> That block is the ONE sanctioned channel for build-time rationale and the runner transcribes it into
> the done record. Do NOT write the done record, the commit message or the PR body.

---

### Claiming this task

```sh
dorfl claim d1-limits-reach-the-stores-batch-bounds --arbiter origin
git fetch origin && git switch -c work/d1-limits-reach-the-stores-batch-bounds origin/main
# on completion, in the work branch's PR/merge:
git mv work/tasks/ready/d1-limits-reach-the-stores-batch-bounds.md work/tasks/done/d1-limits-reach-the-stores-batch-bounds.md
```
