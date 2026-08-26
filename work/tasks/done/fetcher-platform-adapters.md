---
title: Host adapter for the log-fetcher (the Node loop)
slug: fetcher-platform-adapters
spec: historical-state-database
blockedBy: [agnostic-log-fetcher]
covers: [6]
---

## What to build

A host under `platforms/` that decides **when** the fetcher runs, which is the only platform-specific thing about it:

- **Node**: a long-running process driving fetch cycles on an interval, with backoff when the chain is quiet or the server is unreachable.

The scheduling policy (what each cycle outcome means, how long to wait after it) is shared rather than written per host, so that the difference between two hosts can only ever be the schedule and the configuration.

The adapter supplies configuration (the provider endpoint, the server URL, credentials) and nothing else. It contains no fetching and no reorg logic.

### Why there is no Worker adapter

This task originally asked for a second adapter: a Cloudflare Worker running one bounded cycle per cron invocation. It is deliberately not built, and the reason is worth keeping because it will be proposed again.

**Driving the chain needs a host that can hold a process.** A cron trigger fires at most once a minute, a sub-hour schedule caps an invocation at around thirty seconds, and a first sync needs far more than that while holding a whole batch in memory. So a Worker fetcher cannot follow the tip the way a loop can, at any cadence a chain cares about.

Nor is the answer a *combined* Worker that fetches and processes together. A Worker is an excellent host for the indexer-server, whose work is short and per-request and which has content to serve; it is a poor **stream driver** either way, and combining the halves does not change the trigger or the invocation limits. What it changes is only where the batch goes.

So: the serverless runtime hosts the RECEIVING half (`platforms/cf-worker`, `server-platform-adapters`), and the fetching half runs where a process can sit in a loop. That host can push over HTTP to an indexer-server anywhere, including a Worker, or run both halves itself.

### The combined shape

Since a combined host is worth having on Node, the wire needs to be optional rather than assumed. Both sides of the ADR-0004 contract are already interfaces, so this is a transport, not a second implementation: `createDirectIngestion` (`@etherfold/core`) hands a `LogFetcher` straight to a `StreamBuilder` in the same process. The receiver still owns the cursor, still derives every reorg and still refuses a batch that does not start where it says, because none of that came from HTTP.

## Acceptance criteria

- [ ] The Node adapter follows the chain tip continuously and backs off when there is nothing to do or the server is unreachable.
- [ ] Killing and restarting the adapter mid-run loses nothing: the server's `409` puts it back on track without operator intervention, with progress driven entirely by the server's expected cursor rather than by local state.
- [ ] Credentials for the ingestion endpoint come from adapter configuration and are never logged.
- [ ] The adapter contains no fetch or reorg logic, and holds nowhere to persist a block number.
- [ ] The scheduling policy lives in one place, so a second host would differ from this one in scheduling and configuration only.
- [ ] A combined deployment (one process, no wire) drives the same fetcher to the same state as a split one, and needs no endpoint or token to do it.

## Blocked by

- `agnostic-log-fetcher` (the core it schedules).

## Prompt

> Build the host adapter for the log-fetcher in the `etherfold` monorepo, under `platforms/`.
>
> FIRST, check this task against current reality: confirm `agnostic-log-fetcher` landed with the "fetch a range and push it" shape assumed here, and read `docs/adr/0003` and `docs/adr/0004`.
>
> Scheduling is the only platform-specific concern: a Node process runs a loop with backoff. Read the section above on why there is no Worker adapter before proposing one. Follow `~/dev/github/wighawag/template-agnositic-server` for structure.
>
> The property to preserve and to test deliberately: **the fetcher holds no state**, so a kill and restart loses nothing. The server's `409 {expectedFromBlock}` is what puts a restarted fetcher back on track. Test that explicitly rather than assuming it, since it is the whole justification for the stateless design.
>
> Credentials come from adapter configuration and must never be logged. Add a changeset, and do not commit without confirmation.

## Decisions

- **The fetcher host is its own package (`@etherfold/fetcher-host`), and the Node adapter is a second one (`platforms/nodejs-fetcher`), rather than an entry point in `platforms/nodejs`.** The deciding argument is dependencies following deployables: `@etherfold/platform-nodejs` exists to serve `@etherfold/server` over libSQL and Hono, and a fetcher needs none of that, so co-locating them would make every fetcher deployment install a database driver and every server deployment a JSON-RPC provider. ADR-0003 already makes the fetcher its own deployable; the package boundary follows it. The shared package holds everything a host decides that is NOT scheduling (configuration, the classification of a cycle, the wait after each), so that policy exists once. Accepted cost: it has a single consumer, which was reviewed and kept.
- **No Worker adapter, and the reasoning is in the body above rather than only here, because it will be proposed again.** One was built first (a cron-triggered `platforms/cf-worker-fetcher`, bounded per invocation, tested end to end against a D1-backed receiver inside the workers runtime) and then removed on review. Two objections, both correct: a cron cannot follow a chain (at most one trigger a minute, invocations capped around thirty seconds on a sub-hour schedule), and if a Worker could drive fetching at all then the sensible Worker deployment would be one worker doing both halves rather than two workers with a wire between them. The second is not a rescue either: a Worker is a good indexer-server, which serves content and works per request, and a poor stream driver whichever half it is paired with. The serverless runtime therefore hosts the RECEIVING half only.
- **`runBoundedFetcherRun` was built, then deleted with the Worker.** It is the shape a host that gets an invocation would use, and no host in this design gets one. Keeping it "for later" would have cost a public function, five extra `stoppedBecause` values on `RunSummary`, and a test suite asserting that two schedule shapes agree when only one can run. About forty lines to restore if an invocation-scoped host with a workable budget ever appears; the shape that would want it is a one-shot catch-up job, which is the CLI's territory rather than this package's.
- **The wire is optional, which is what makes a combined host on Node work.** `endpoint` and `token` are resolved as optional and demanded at host CONSTRUCTION, only when the host is really going to push over HTTP. They cannot be demanded at configuration time, because whether a wire is required depends on whether the caller supplies its own `IngestionTarget`, which is not part of an environment. This closed a real hole: as first built, a combined process would have been forced to invent a URL and a shared secret for a network that is not there. The combined shape needed no new entry point, since `dependencies.target` already existed.
- **`createDirectIngestion` was added to `@etherfold/core`** (its own module, not inside `ingestClient.ts`, which is explicitly the HTTP transport). Both sides of ADR-0004 were already interfaces, so this is about eighteen lines and it makes the split a genuine deployment choice. The one thing it must get right is that `UnexpectedFromBlockError` comes back as a `CursorCorrection` rather than as a throw, since that is the in-process `409` and the ordinary path after a restart, a lost acknowledgement or a second sender. It is recognised STRUCTURALLY, not with `instanceof`, on the same argument core already makes for `retryable`: two copies of the package in one dependency tree would otherwise turn the one resumable refusal into a crash, and only in deployments that bundle awkwardly. It is also added to core's sending-path source scan, so it is held to the same no-host, no-cursor, no-reorg-derivation rules as the rest.
- **Backoff, and which outcomes are failures.** Still behind the tip: no wait, since there is known work left and a first sync is a run of these. At the tip, or `up-to-date`: one poll interval. `yielded`: an escalating wait, warned about only after three consecutive, because one is what redundant fetchers do to each other and a run of them is a signal that the cursor is moving under every cycle this fetcher starts. Retryable failure: escalating from one second to a minute. All escalations are jittered, deliberately: running fetchers redundantly is a design goal and two of them backing off in lockstep retry in lockstep. The split between retry and stop is read off the error's own `retryable` and never re-derived from a status code, and there is no option to carry on past a refusal, because that switch could only produce the failure the two refusal codes exist to prevent.
- **A refusal is loud.** `etherfold-fetch` exits `1` on a non-retryable failure rather than staying up, since a fetcher that is running and achieving nothing is indistinguishable from a working one until somebody reads the state it is not producing.
- **Batch size: mitigated in configuration, not fixed, and the note stays open.** `MAX_EVENTS_PER_FETCH` and `MAX_BLOCKS_PER_FETCH` are exposed as deployment knobs and both work the legal way, by narrowing the range and so lowering `toBlock`. They bound a batch by event count and block span, which are proxies and not bounds in bytes. A real byte bound needs an estimate computed where the payload is built (inside `LogFetcher.fetchCompleteRange`, next to the truncation guard that already lowers `toBlock`) plus a `413` where it is received, so it has two owners and neither is a host. `work/notes/observations/nothing-bounds-the-size-of-an-ingest-batch.md` was updated rather than discharged, including a correction to where the failure now lands: a first sync arrives at a Worker-hosted indexer-server as one enormous POST, which is the note's original worry with the halves either side of a real network.
- **`suspectResultCount` is resolved INDEPENDENTLY of `maxEventsPerFetch`, and never allowed to follow it.** Core defaults the first to the second; since a host may lower the second for batch size, letting the first follow would make every fetch landing on the lowered number re-fetch a halved range for nothing, and would stop the fetcher outright on a single block holding exactly that many. So both are passed explicitly, the independence is pinned by a test, and the knob is documented in the README, in the config type and in the startup log line, which states what the current value ASSERTS about the operator's node rather than merely reporting it.
- **Credentials, including the one that does not look like one.** The token is never logged, never thrown and never reported. The RPC URL is treated as a credential too and logged host-only, because `.../v2/<api-key>` is the standard shape at every hosted provider and the startup line is exactly what gets pasted into an issue. The test for this hooks the real `named-logs` factory from a vitest setup file, which is the only moment a hook takes effect (a module resolves its logger at import), so it reads what the shipped code actually writes rather than a mock.
- **A note for whoever touches the Node tests: the outage is simulated at the transport, not by closing a socket.** In this environment a connection to a closed port takes about ten seconds to fail (packets dropped, so undici's connect timeout rather than a refusal), which made a real-socket outage test slow and environment-dependent. What is under test is the loop's reaction to an unreachable server, not the operating system's, and the server on the other side stays real throughout, so the recovery is real.
