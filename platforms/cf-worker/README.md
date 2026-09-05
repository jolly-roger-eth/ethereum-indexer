# @etherfold/platform-cf-worker

The Cloudflare Worker host for [`@etherfold/server`](https://github.com/wighawag/etherfold/tree/main/packages/server): it supplies a D1-backed `RemoteSQL` and the Worker env, and it is where D1's per-request limits are named.

**A deployable, not a library.** It is `private` and never published: what you take from it is the wiring, by reading it or by copying it into your own Worker.

## When you want this

A Worker is a good home for the RECEIVING half of a split deployment: `/{indexer}/ingest` is short, per-request work. It is a poor home for the chain-facing half, because a cron fires on a schedule rather than continuously and an invocation is capped well below a first sync. So the fetcher runs somewhere that can hold a process ([`@etherfold/platform-nodejs-fetcher`](https://github.com/wighawag/etherfold/tree/main/platforms/nodejs-fetcher)) and pushes here.

To run a server on Node instead, use [`@etherfold/platform-nodejs`](https://github.com/wighawag/etherfold/tree/main/platforms/nodejs) or [`etherfold serve`](https://github.com/wighawag/etherfold/tree/main/packages/cli).

## The wiring

```ts
import {createServer} from '@etherfold/server';
import {createD1DB} from './d1.js';

export const app = createServer<CloudflareEnv>({getDB: (c) => createD1DB(c.env), getEnv: (c) => c.env});
export default {fetch: app.fetch};
```

The D1 binding arrives on the PER-REQUEST `env`, which is exactly why the server resolves its database per request rather than once at construction.

Two things this host deliberately does NOT do:

- **It does not apply the schema on boot.** The Node adapter does, because there is one process owning one file. Here there are many instances against one D1, so migration is an operator action: `POST /admin/setup`, or wrangler.
- **It hosts no processor**, so it passes no `getIndexer` and the ingestion routes answer `501` under every name. A deployment that DOES host one bundles its processor and builds its store with `createD1Store` (`src/d1.ts`).

## D1's limits live here, and nowhere else

[`@etherfold/state-store-sqlite`](https://github.com/wighawag/etherfold/tree/main/packages/state-store-sqlite) targets the `remote-sql` interface, so a hosted backend is one backend among several and never the target; a test there asserts that no source file names D1. A HOST is the one place allowed to name its own backend, which is why the documented caps are in `src/d1.ts` and why they reach the store as CONFIGURATION (`BatchBounds`) rather than as constants inside it.

Which plan a deployment runs on is STATED, in `wrangler.toml`:

```toml
[vars]
D1_PLAN = "free"   # or "paid"
```

Nothing on a request tells a Worker its plan, and the two caps differ by 20x: guessing high breaks a Free deployment in production, guessing low costs a Paid one 20x the round trips. An unknown value is refused rather than read as the default. A named wrangler environment does not inherit the top-level `[vars]`, so the value is repeated per environment rather than assumed.

Pruning is budgeted the same way (`d1PruneBudget`): D1's query cap is per INVOCATION and a prune is a loop of small requests, so a host schedules it with a budget instead of letting a write trigger it (ADR-0022).

The numbers themselves are the DOCUMENTED ones and are dated in `work/notes/findings/d1-caps-bound-parameters-per-query-at-100.md`; Cloudflare revises them, so re-fetch before relying on them.

## Commands

```sh
pnpm --filter @etherfold/platform-cf-worker dev      # wrangler dev
pnpm --filter @etherfold/platform-cf-worker test     # vitest, on @cloudflare/vitest-pool-workers
pnpm --filter @etherfold/platform-cf-worker build    # typecheck + a wrangler dry-run deploy
pnpm --filter @etherfold/platform-cf-worker deploy:production
```

`database_id` in `wrangler.toml` is intentionally blank: a deployment fills in its own.
