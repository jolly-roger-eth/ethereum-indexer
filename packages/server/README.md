# @etherfold/server

The indexer-server, minus any host. A [Hono](https://hono.dev) app that receives its database, its environment and (optionally) the stream-builder it folds with by INJECTION, so the same routes run on Node, on a Cloudflare Worker, or on anything else with a `fetch`.

It knows `RemoteSQL` and nothing else: no Node built-ins, no Cloudflare types, no D1. A test asserts that no source file here names a runtime.

## When you want this package

You are building a HOST. Everything platform-shaped -- which database, which environment, how the app is served -- is the host's, and the shipped ones are [`@etherfold/platform-nodejs`](../../platforms/nodejs) and [the Cloudflare Worker host](../../platforms/cf-worker). Reach for this package directly to write a third.

To simply RUN a server on Node, use [`etherfold serve`](../cli). To index into a database in one shot, use `etherfold index`.

## What a host supplies

```ts
import {createServer} from '@etherfold/server';

export const app = createServer<MyEnv>({
	getDB: (c) => myRemoteSQL(c.env), // resolved PER REQUEST: a Worker's binding arrives on `env`
	getEnv: (c) => c.env,
	// OPTIONAL: the stream-builder this deployment folds with, if it hosts one
	getIngestion: (c) => myStreamBuilder(c),
});
```

`getIngestion` is optional because an indexer-server is useful before it ingests anything: `/status` and `/admin/setup` answer on a server with no processor at all. When it is absent the ingestion routes answer `501`, which says "this server does not do that" rather than pretending the route is missing.

## The routes

| route | |
| --- | --- |
| `GET /status` | health, database reachability, the fixed-schema version against the one this build expects, the reorg counters and the last error this PROCESS saw. `503` when the database is unreachable or the schema is not the expected version |
| `POST /admin/setup` | apply the fixed-table schema |
| `POST /ingest` | a `WireBatch` from a log-fetcher (ADR-0004) |
| `POST /ingest/expected-from-block` | where the next batch must start |

**`/ingest` is the fetcher's private API and is guarded on the PATH**, read included. Authentication is `Authorization: Bearer <INGEST_TOKEN>`, compared without leaking where two secrets first differ, and it FAILS CLOSED: with no `INGEST_TOKEN` configured the server can authenticate nobody, so every ingestion call is refused with `401`.

**The status codes are the interesting part of the contract.** `409` is the one and only RESUMABLE refusal: it carries `expectedFromBlock`, and a sender's whole recovery is to re-send from there. `400` is a sender that is wrong in a way no block number fixes (a foreign `{source, config}`, a malformed range, a payload that is not the range it claims). Collapsing the two would make a misconfigured fetcher retry forever against a server that will never accept it.

**There is no idempotency key and no dedupe table: the cursor IS the key.** A batch re-sent after a lost acknowledgement fails the `expectedFromBlock` check and is corrected, so at-least-once on the wire is exactly-once in effect.

**`/ingest/expected-from-block` is a POST for a question**, deliberately. Answering it can WRITE, because reading the cursor reconciles one belonging to a different source, config or processor version. A `GET` that writes is a trap whatever its justification, so the method matches what it does.

`/status` reports reverts concluded from ABSENCE separately from those concluded from a hash CONTRADICTION, because absence is an inference and a rising rate of it means truncation or misconfiguration rather than chain activity. It does not make the server unhealthy: it is a signal to investigate, not a fault.

## Typed client

```ts
import {createClient} from '@etherfold/server';

const client = createClient('https://indexer.example');
```

The Hono RPC client type is computed at compile time from the app, so a route change breaks a caller at compile time.

## Related

[`@etherfold/core`](../core) for the `StreamBuilder` on the other side of `getIngestion` and the wire types, [`@etherfold/fetcher-host`](../fetcher-host) for the sender, and [`@etherfold/state-store-sqlite`](../state-store-sqlite) for what a host that DOES host a processor folds into.

## Tests

`pnpm --filter @etherfold/server test`, vitest.
