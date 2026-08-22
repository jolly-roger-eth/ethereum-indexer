---
title: Host adapters for the log-fetcher (Node loop and Worker cron)
slug: fetcher-platform-adapters
spec: historical-state-database
blockedBy: [agnostic-log-fetcher]
covers: [6]
---

## What to build

Host adapters under `platforms/` that decide **when** the fetcher runs, which is the only platform-specific thing about it:

- **Node**: a long-running process driving fetch cycles on an interval, with backoff when the chain is quiet or the server is unreachable.
- **Cloudflare Worker**: a scheduled (cron) trigger running one bounded cycle per invocation, since a Worker cannot hold a loop.

That difference is the whole reason the fetcher core was kept to "fetch this range and push it": a loop and a cron trigger are then the same operation invoked differently, rather than two implementations.

Each adapter supplies configuration (the provider endpoint, the server URL, credentials) and nothing else. Neither contains fetching or reorg logic.

## Acceptance criteria

- [ ] Both adapters drive the same fetcher core, and a fetch cycle behaves identically under each.
- [ ] The Node adapter follows the chain tip continuously and backs off when there is nothing to do or the server is unreachable.
- [ ] The Worker adapter completes a **bounded** cycle within one scheduled invocation and resumes correctly on the next, with progress driven entirely by the server's expected cursor rather than by local state.
- [ ] Killing and restarting either adapter mid-run loses nothing: the server's `409` puts it back on track without operator intervention.
- [ ] Credentials for the ingestion endpoint come from adapter configuration and are never logged.
- [ ] Neither adapter contains fetch or reorg logic; the diff between them is scheduling and configuration only.

## Blocked by

- `agnostic-log-fetcher` (the core they schedule).

## Prompt

> Build the two host adapters for the log-fetcher in the `etherfold` monorepo, under `platforms/`.
>
> FIRST, check this task against current reality: confirm `agnostic-log-fetcher` landed with the "fetch a range and push it" shape assumed here, and read `docs/adr/0003` and `docs/adr/0004`.
>
> Scheduling is the only platform-specific concern: a Node process runs a loop with backoff, a Worker runs one bounded cycle per cron invocation. Both drive the same core. Follow `~/dev/github/wighawag/template-agnositic-server` for structure.
>
> The property to preserve and to test deliberately: **the fetcher holds no state**, so a kill and restart, or a Worker invocation that ends mid-range, loses nothing. The server's `409 {expectedFromBlock}` is what puts a restarted fetcher back on track. Test that explicitly rather than assuming it, since it is the whole justification for the stateless design.
>
> The Worker cycle must be bounded so it fits an invocation, and must make progress across invocations using only the server's cursor, never local state.
>
> Credentials come from adapter configuration and must never be logged. Add a changeset, and do not commit without confirmation.
