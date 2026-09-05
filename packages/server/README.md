# @etherfold/server

The indexer-server, minus any host. A [Hono](https://hono.dev) app that receives its database, its environment and (optionally) the stream-builder it folds with by INJECTION, so the same routes run on Node, on a Cloudflare Worker, or on anything else with a `fetch`.

It knows `RemoteSQL` and nothing else: no Node built-ins, no Cloudflare types, no D1. A test asserts that no source file here names a runtime.

## When you want this package

You are building a HOST. Everything platform-shaped -- which database, which environment, how the app is served -- is the host's, and the shipped ones are [`@etherfold/platform-nodejs`](https://github.com/wighawag/etherfold/tree/main/platforms/nodejs) and [the Cloudflare Worker host](https://github.com/wighawag/etherfold/tree/main/platforms/cf-worker). Reach for this package directly to write a third.

To simply RUN a read tier on Node, use [`etherfold serve`](https://github.com/wighawag/etherfold/tree/main/packages/cli). To fold into a database in one shot, use `etherfold build`.

## What a host supplies

```ts
import {createServer, indexerRegistry} from '@etherfold/server';

export const app = createServer<MyEnv>({
	getDB: (c) => myRemoteSQL(c.env), // resolved PER REQUEST: a Worker's binding arrives on `env`
	getEnv: (c) => c.env,
	// OPTIONAL: the NAMED INDEXERS this deployment hosts, resolved by name
	getIndexer: indexerRegistry({alpha: myStreamBuilder, beta: myOtherStreamBuilder}),
	// OPTIONAL: where this deployment's pipeline has got to, if it owns a store
	getCursorReport: async (c) => ({lastToBlock: await myStore.howFar()}),
});
```

`getIndexer` is the NAME-KEYED REGISTRY of the named indexers this host was built with. A **named indexer** is the multi-tenancy unit: one indexed answer set over one chain, fully isolated from every other (ADR-0036). It resolves an ENTRY OBJECT (`{ingestion}`) rather than a bare `LogIngestion`, so that what a name holds can grow -- a later generation model gives one entry several live wire contexts -- without every host's resolver changing shape. `indexerRegistry` builds one from a plain record; a host whose names depend on the request writes the function itself.

It is optional because an indexer-server is useful before it ingests anything: `/status` and `/admin/setup` answer on a server with no processor at all. When it is absent the ingestion routes answer `501` under every name, which says "this server does not do that" rather than pretending the route is missing. That is deliberately a different answer from a registry that does not hold the name asked for, which is a `404`: one is a capability this host lacks, the other is a tenant it was not built with.

`getCursorReport` is optional for the same kind of reason: only the process that OWNS the store can read a cursor, and this package has no store dependency. A host with none (the Cloudflare Worker host is one) injects no reporter and `/status` carries no `cursor` field, rather than an invented one.

**What a reporter owes the server: a SMALL, JSON-serialisable summary, and never the store's raw serialized cursor.** That value is a serialized `LastSync` carrying an unconfirmed window of DECODED EVENTS, so handing it over whole would put an unbounded blob on the one page an operator refreshes while something is wrong. The constraint lives on the seam because `/status` reports what the reporter returns VERBATIM: the server does not parse it (the cursor is opaque behind the storage seam, ADR-0027, and only the processor knows what one means), so it cannot bound it afterwards either.

## The routes

| route | |
| --- | --- |
| `GET /status` | health, database reachability, the fixed-schema version against the one this build expects, the reorg counters, the injected cursor report and the last error this PROCESS saw. `503` when the database is unreachable or the schema is not the expected version |
| `POST /admin/setup` | apply the fixed-table schema |
| `POST /{indexer}/ingest` | a `WireBatch` from a log-fetcher (ADR-0004), for ONE named indexer |
| `POST /{indexer}/ingest/expected-from-block` | where that named indexer's next batch must start |

**The indexer NAME is a ROUTE SEGMENT and is never in the envelope.** Carrying it in the payload was considered and rejected: it would make the wire FORMAT carry tenancy, and it would turn a misdirected batch into a payload error rather than a routing one. ADR-0004's envelope and its refusal families are unchanged, and one refusal sits beside them: a name this host was not built with is a `404 unknown-indexer`, never a default to the indexer it does happen to hold.

**The ingest routes are the fetcher's private API and are guarded on the PATH**, read included. Authentication is `Authorization: Bearer <INGEST_TOKEN>`, compared without leaking where two secrets first differ, and it FAILS CLOSED: with no `INGEST_TOKEN` configured the server can authenticate nobody, so every ingestion call is refused with `401`.

**The status codes are the interesting part of the contract.** `409` is the one and only RESUMABLE refusal: it carries `expectedFromBlock`, and a sender's whole recovery is to re-send from there. `400` is a sender that is wrong in a way no block number fixes (a foreign `{source, config}`, a malformed range, a payload that is not the range it claims). Collapsing the two would make a misconfigured fetcher retry forever against a server that will never accept it.

**There is no idempotency key and no dedupe table: the cursor IS the key.** A batch re-sent after a lost acknowledgement fails the `expectedFromBlock` check and is corrected, so at-least-once on the wire is exactly-once in effect.

**This route COUNTS no reorgs, and that is deliberate.** It used to, which quietly made an operational counter a fact about the TRANSPORT: a combined process folds through `createDirectIngestion`, reaches no route, and reported no reverts at all. A revert is concluded by the FOLD, so it is counted once inside `StreamBuilder.receive` and persisted by whoever owns the store (ADR-0050) -- this package reads those counts for `/status` and writes none. A host that wants them supplies a `ReorgRecorder` to the stream-builder it builds, exactly as it already supplies the database, the environment, the registry and the cursor reporter.

**What this route DOES write is the stored EMISSION STREAM** (ADR-0006): an append-only `EmissionStream` row per emitted log, retractions INCLUDED, superseded rows FLAGGED rather than deleted, so no retraction information is ever destroyed and the canonical view stays a cheap derived read. Every row carries two DISCRIMINATORS, both structurally part of every read and write and neither ever defaulted: the INDEXER NAME (this request's route segment) and the STREAM. The stream's value is `LogIngestion.streamDigest`, the wide digest over the fetch filter plus the stream config -- deliberately NOT the wire context's `{source, config}`, which is a 32-bit whole-entry hash kept whole as an identity check between two halves of a deployment (ADR-0034): as a key it would move on a decode-only ABI change and orphan every stored row, and it would collide. Nothing about the PROCESSOR is a column and there is no generation column, because a processor change is a new generation over the SAME stream.

The write is on the ROUTE rather than inside the fold, which is the opposite placement from the reorg count above, and for a reason about the KEY rather than about the fact: half of it is the indexer name, and the route segment is the only place that value exists (an entry deliberately carries no name, and `run` / `build` refuse `--indexer` outright). The visible consequence is that a COMBINED `etherfold run`, which folds through the direct in-process wire, stores no emission stream today.

**`/{indexer}/ingest/expected-from-block` is a POST for a question**, deliberately. Answering it can WRITE, because reading the cursor reconciles one belonging to a different source, config or processor version. A `GET` that writes is a trap whatever its justification, so the method matches what it does.

`/status` reports reverts concluded from ABSENCE separately from those concluded from a hash CONTRADICTION, because absence is an inference and a rising rate of it means truncation or misconfiguration rather than chain activity. It does not make the server unhealthy: it is a signal to investigate, not a fault.

**`/status` is the WHOLE query surface for now, deliberately, and the `cursor` field is the whole observability story.** A richer query layer (GraphQL over entity declarations) is decided in principle and is explicitly NOT in this milestone, so a running deployment is watched here or nowhere. The field is an OBJECT and never a bare value (ADR-0047):

```json
{"cursor": {"reported": true, "value": {"lastToBlock": 4242}}}
{"cursor": {"reported": false, "reason": "the cursor table is locked"}}
```

The envelope is the server's and the `value` is the host's, untouched. It is an object so that the GENERATION dimension can grow INSIDE it later (an indexer already holds several generations and reports progress per generation; the server does not hold them yet, so it reports one cursor and a later host adds a key beside `value`), and so that a broken reporter is distinguishable from a host that simply has no store: **a reporter that throws, rejects, reports nothing or returns something unserialisable degrades to `reported: false` with a reason** and never fails the request or changes `healthy`, exactly as the reorg counters degrade.

## Typed client

```ts
import {createClient} from '@etherfold/server';

const client = createClient('https://indexer.example');
```

The Hono RPC client type is computed at compile time from the app, so a route change breaks a caller at compile time.

## Related

[`@etherfold/core`](https://github.com/wighawag/etherfold/tree/main/packages/core) for the `StreamBuilder` on the other side of `getIndexer` and the wire types, [`@etherfold/fetcher-host`](https://github.com/wighawag/etherfold/tree/main/packages/fetcher-host) for the sender, and [`@etherfold/state-store-sqlite`](https://github.com/wighawag/etherfold/tree/main/packages/state-store-sqlite) for what a host that DOES host a processor folds into.

## Tests

`pnpm --filter @etherfold/server test`, vitest.
