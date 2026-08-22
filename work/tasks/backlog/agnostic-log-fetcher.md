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
