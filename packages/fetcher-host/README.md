# @etherfold/fetcher-host

The host-side half of the etherfold **log-fetcher**: everything a host needs that is *not* scheduling.

`LogFetcher` in `@etherfold/core` answers what a fetch cycle **is** (work out where to start, fetch a contiguous range of logs, push it) and deliberately says nothing about **when** one runs. That is a host's business. This package is the layer in between, and it exists so that the layer exists once: the only thing that should differ between two hosts is the schedule, and two copies of "what do I do after a `yielded` cycle" would drift on the first bug fixed in one of them.

It names no runtime. A loop needs `setTimeout` and a bounded run needs `Date.now`, which every targeted runtime has.

`@etherfold/platform-nodejs-fetcher` is the adapter built on it: a process, its signals, an exit code.

### Why there is only one schedule shape

Because driving the chain needs a host that can hold a **process**. A serverless runtime is a good home for the *receiving* half, whose work is short and per-request, and a poor one for this half: its trigger fires on a schedule rather than continuously, its invocations are capped well below what a first sync takes, and a batch has to be held in memory while it is built. So there is no invocation-shaped scheduler here, and no serverless fetcher to want one.

What does vary is **where the batch goes**, and that arrives as one dependency:

| | |
| --- | --- |
| split | `createHttpIngestion` pushes to an indexer-server elsewhere, which is a fine thing to host on a Worker |
| combined | `createDirectIngestion(builder)` hands the batch to a stream-builder in this same process, so one deployable runs both halves |

Both are `IngestionTarget`s, so nothing else about this package changes between them. `endpoint` and `token` are therefore optional: a combined host has no network to point at and nobody to authenticate to, and `FetcherHost` refuses at construction only if it finds neither a target nor an endpoint.

## What it does

```ts
import {createFetcherHost, resolveFetcherHostConfig, runFetcherLoop} from '@etherfold/fetcher-host';

const host = createFetcherHost(resolveFetcherHostConfig(process.env));
await runFetcherLoop(host);
```

**`resolveFetcherHostConfig(env, overrides)`** turns a plain record of strings into a deployment's configuration. Both adapters call it, which is what makes their configuration identical rather than merely similar: the same names, the same defaults, the same refusals. The full variable list is in the [Node adapter's README](https://github.com/wighawag/etherfold/tree/main/platforms/nodejs-fetcher).

**`host.runCycle()`** runs one cycle and classifies it. It does not throw and it does not wait:

| report | what happened | what a host does |
| --- | --- | --- |
| `progress` | a batch landed. `caughtUp` says whether it reached the tip | keep going, or poll |
| `idle` | `up-to-date`: the chain has nothing above the cursor | poll |
| `contended` | `yielded`: corrected repeatedly without landing, which is what redundant fetchers do to each other | back off, and warn after a *run* of them |
| `retry` | it failed, and the error says waiting could help | back off, escalating |
| `fatal` | it failed, and the error says nothing will help | stop, loudly |

The last two are split by the error's own `retryable` flag and by nothing else: not a status code, not a message, and not a list of error names kept here, which would drift the moment `@etherfold/core` gained another refusal. A test asks it of a real instance of every error core throws.

**`host.delayFor(report)`** is the wait, escalating and jittered for the two that repeat. The jitter is not decoration: running fetchers redundantly is a design goal, and two of them backing off in lockstep retry in lockstep.

**`runFetcherLoop(host, {signal})`** drives cycles until it is asked to stop, or until a refusal no retry can fix. There is deliberately no "carry on past a refusal" option: what to do about one is the adapter's (exit non-zero), and that is louder than staying up.

## What it does not do

**It holds no cursor, and neither may a host built on it.** The indexer-server is authoritative about where the next batch starts (ADR-0004); a `409` is the correction path, not an error. The only things a `FetcherHost` keeps between cycles are two counters about the current run, and both are dropped on progress. A block number written down on this side is a second opinion of a value the server owns, and it is wrong exactly when it matters.

**It contains no fetch or reorg logic.** Those are core's and the receiver's respectively.
