---
title: Stateless log-fetcher core
slug: agnostic-log-fetcher
spec: historical-state-database
blockedBy: [ingest-wire-receiving-side]
covers: [5]
---

## What to build

The chain-facing half of the pipeline, and the component whose defining property is that **it holds no state at all**. It fetches a contiguous block range over EIP-1193 and pushes it to the server. It does not track a cursor, does not maintain an unconfirmed window, and contains no reorg logic. That is what makes it restartable, replaceable and safe to run redundantly.

Its core reduces to one operation, "fetch this range and push it", which is why the host adapter (a loop, a cron trigger) is a separate concern and a separate task.

Behaviour:

- Ask the server where to start, or learn it from a `409`, and push `[fromBlock, toBlock]`.
- On a `409 {expectedFromBlock}`, re-send from there. This is the normal resumption path after a restart, not an error path.
- **Provider truncation is a hard error, never a partial result.** If the provider signals a capped result set (the familiar "more than N results" family of errors), **lower `toBlock` and retry**; never deliver a partial range. The receiver cannot distinguish a short payload from "no logs in that range", and would read the gap as a reorg and delete state. This is the single most dangerous thing this component can get wrong.
- Re-fetching the unconfirmed window every round is normal steady state, not a retry: the server asks for it so it can detect reorgs by comparing hashes.

## Acceptance criteria

- [ ] A fetch cycle pushes a contiguous range and, given a `409`, re-sends from the expected block without operator intervention.
- [ ] A restart with no persisted state resumes correctly, driven entirely by the server's expected cursor.
- [ ] A provider result-cap error causes `toBlock` to shrink and the range to be retried, and **no partial range is ever pushed**. This is asserted against a provider stub that truncates.
- [ ] A provider that silently returns exactly the cap without an error is treated as suspect rather than as a complete answer.
- [ ] Transient provider failures are retried with backoff and surfaced after a bounded number of attempts.
- [ ] The package holds no cursor, no unconfirmed-block tracking and no reorg logic, and a reviewer can confirm that by reading it.
- [ ] No host-specific API is used: no scheduler, no Node built-ins, no Cloudflare types. Scheduling belongs to the platform adapter.

## Blocked by

- `ingest-wire-receiving-side` (the endpoint contract it speaks to).

## Prompt

> Build the stateless log-fetcher core for the `etherfold` monorepo.
>
> FIRST, check this task against current reality: read `docs/adr/0003` and `docs/adr/0004`, and confirm `ingest-wire-receiving-side` landed with the contract assumed here. If not, route to needs-attention.
>
> This component fetches a contiguous block range over EIP-1193 and pushes it to the indexer-server. It must hold NO state: no cursor, no unconfirmed window, no reorg logic. All of that lives on the receiving side, which is authoritative. A `409 {expectedFromBlock}` is not an error path, it is how a restarted fetcher learns where to resume.
>
> The one thing that must not be got wrong: **never push a partial range.** Providers cap `eth_getLogs` results, and the receiver cannot distinguish "you sent me fewer logs than exist" from "there were no logs there", so it would read the gap as a reorg and DELETE state. On any truncation signal, lower `toBlock` and retry. Treat a result set that lands exactly on a known provider cap as suspect rather than complete, since some providers truncate without an error. There is a related bug in this repo's history (`d24872f`) that shows how expensive a silently-shortened log set is.
>
> Re-fetching the unconfirmed window on every round is expected steady state, not a retry: the server deliberately asks for it so it can compare block hashes and spot reorgs.
>
> Keep it host-agnostic per `~/dev/github/wighawag/template-agnositic-server`: no scheduler, no Node built-ins, no Cloudflare types. The core is "fetch this range and push it"; how often that runs is the platform adapter's business (a separate task).
>
> Test against a provider stub that can truncate, fail transiently, and reorg. Add a changeset, and do not commit without confirmation.

## Decisions

- **The fetcher core lives in `@etherfold/core`, not in a new package.** The task's wording ("the package holds no cursor") can be read as asking for one. I followed the precedent its counterpart set: `StreamBuilder` (the receiving logic) is in core and `@etherfold/server` is only the HOST; symmetrically the sending logic is in core and `platforms/*` will be the hosts (`fetcher-platform-adapters`). The deciding argument is the truncation primitive: `RangeLogFetcher`/`LogEventFetcher` are core internals, and the alternative was either widening core's public surface to export them or writing a second adaptive `eth_getLogs` loop in another package — a second implementation of precisely the thing whose failure deletes state. Cost: a fetcher deployment installs core, including `EthereumIndexer` it will not use.
- **A `409` is followed INSIDE the cycle, at most `maxCorrectionsPerCycle` (default 2) times, then the cycle ends as `yielded`.** Re-sending immediately is the whole recovery, so it should not wait for the next tick. But repeated corrections mean another sender is moving the cursor while we fetch, and looping on that is a race with no end; yielding is safe because the next cycle picks up whatever is left. `yielded` is deliberately an outcome, not an error: running fetchers redundantly is a design goal.
- **What is cached between cycles: one number, `expectedFromBlock`, in memory, never persisted, and dropped on any push failure.** It saves one round-trip per cycle. It is dropped after a failed push specifically because a lost acknowledgement may hide a batch that WAS applied, so continuing from a remembered number would push a range that is guaranteed to be refused; asking is both cheaper and honest. The adaptive range state inside `RangeLogFetcher` (how many blocks this node tolerates) also survives a cycle: it is a cache of a provider's limits, not of the chain or the cursor, and losing it costs a re-probe.
- **A fetch range is bounded by asking, never by assuming, and a silent cap is not believed.** An announced cap is already handled by `RangeLogFetcher`, which shrinks and reports `toBlockUsed`; that value becomes the batch's `toBlock`, so the range is lowered and never partial. For the silent case I added a rule the repo did not have: a result set landing on `suspectResultCount` is halved and re-fetched until it comes back under the cap, and a SINGLE block still landing exactly on it throws `SuspectedTruncationError` with nothing pushed. That is a deliberate refusal to make progress: a legitimately huge block stalls this fetcher until configured, chosen over the alternative, which can delete state silently.
- **`suspectResultCount` is a DEPLOYMENT's responsibility, and the default only catches a node capping at exactly 10000.** Silent truncation is detectable only by matching the cap exactly — a capped answer and a complete one differ in nothing else — so a node that silently caps at, say, 5000 defeats the default and pushes a short range as a complete one. This is the sharpest edge on the component and it cannot be closed in code, so it is stated at the option, in the class docblock, in the changeset and in `CONTEXT.md`. It is explicitly NOT `fetch.maxEventsPerFetch`: raising that also widens the span each fetch asks for, making truncation likelier rather than less likely.
- **Retryability is a property of the error class (`readonly retryable`), read structurally, not a list of error names kept by the fetcher.** The two are the same fact, and a list in another file drifts: adding a refusal type to `errors.ts` would have got it retried forever, which is the exact failure ADR-0004's two refusal codes exist to prevent. Reading `err.retryable === false` rather than `instanceof` means an error crossing from a second copy of `@etherfold/core` still classifies correctly. An error WITHOUT the property is retried, deliberately: those are the ones this package did not throw (a node's JSON-RPC error, a dropped socket), where transience is the honest default. `NoFetchProgressError` was added so that the should-be-unreachable case is typed rather than defaulting to "transient".
- **The give-up outcome is named `yielded` and carries `corrections`, rather than `superseded`.** The fetcher cannot know that another sender is ahead; it only knows it was corrected N times without landing. The status now states what this side did, the docs name the usual cause as a cause rather than a fact, and a host can tell "gave up once" from "gives up every cycle".
- **The fetcher checks `eth_chainId` before fetching and again before pushing.** New RPC cost per cycle (two cheap calls, three on a corrected cycle) for a check only this side can make: the receiver holds no provider by design, so a fetcher on the wrong endpoint hands it another chain's logs under a valid identity. Mirrors `EthereumIndexer`, which also checks both sides of a fetch.
- **The receiver's reported `context` is compared at ask-time**, so a misconfigured deployment fails before fetching a single log instead of on its first `400`.
- **Internal rename: `LogFetcher` → `RangeLogFetcher`** (`internal/engine/`), and its test file with it. Two classes named `LogFetcher` in one package was not sustainable once the public one existed. Internal only; `LogFetcherConfig` and `FetchConfig` keep their names, so no published type changed.
- **`FetchLike` accepts a bare `Response` as well as a promise**, because that is what an in-process handler returns; it is awaited either way, and this is what lets the round-trip test drive the real routes with no socket.
- **Two documentation surfaces outside this package were edited, both on request after review**: `docs/adr/0004` gained a block quote settling that "raw logs" means *not reorg-annotated* rather than *undecoded* (the ambiguity `ingest-wire-receiving-side` flagged), and its completeness consequence now also binds the fetcher to distrust a silent cap. `packages/processor-sqlite/test/deployment-shapes.test.ts` now drives the SHIPPED `LogFetcher` instead of a local `captureStream` loop, and uses the published `WireBatch` type; its receiving half stays `EthereumIndexer.feed` behind a refusing provider on purpose, since `StreamBuilder` takes no provider and pointing it there would disarm that file's boundary check.
- **Known gap, captured not built**: nothing bounds the BYTE size of a batch on either half of the wire, which is a plausible first-sync failure on a Worker (`work/notes/observations/nothing-bounds-the-size-of-an-ingest-batch.md`). The fix is to lower `toBlock` until the payload fits, never to send part of a range, and it needs a byte estimate the fetcher does not currently compute.
