# @etherfold/platform-nodejs

The Node host for [`@etherfold/server`](../../packages/server): it supplies a libSQL-backed `RemoteSQL` and the process environment, and serves the app over HTTP.

That is the whole adapter. No route, no chain logic and no storage decision lives here: those are the server's and the engine's.

## When you want this package

| you want | use |
| --- | --- |
| a server on Node, from a terminal | [`etherfold serve`](../../packages/cli), which calls this |
| a server on Node, inside your own program | here |
| a server on Cloudflare Workers | [`platforms/cf-worker`](../cf-worker) |
| a host for a runtime neither of those covers | [`@etherfold/server`](../../packages/server) directly |

## Minimal usage

```ts
import {startServer} from '@etherfold/platform-nodejs';

const running = await startServer({db: 'file:./etherfold.db', port: 2000});
console.log(running.url); // http://localhost:2000  --  /status is there
await running.close();
```

`createNodeDB(url)` is exported separately, so a program that wants the same libSQL handle for something else (the CLI's `index` command does) builds it the same way the server does.

| option | default |
| --- | --- |
| `db` | the `DB` variable, else `file:./etherfold.db` |
| `port` | the `PORT` variable, else `2000`. Pass `0` for any free port; `running.port` reports the one it got |
| `hostname` | Node's default |
| `autoSetup` | `true`: apply the fixed-table schema at startup if it is not already there |
| `env` | overrides merged over `process.env` |

`INGEST_TOKEN` is read from the environment by the server itself, and ingestion is refused outright without it.

**`autoSetup` defaults ON here and is deliberately absent on the Worker host.** Node is the single-operator case: one process, owning one database file, where making a user POST to an admin route before the server is usable is ceremony with no safety payoff. On Workers there are many instances against one D1, so migration stays an operator action rather than something several isolates race to do.

This host passes no `getIngestion`, so the deployment it starts SERVES a database rather than folding into one: `/status` and `/admin/setup` answer, and ingestion answers `501`. A deployment that receives pushes from a log-fetcher builds its own app with `createServer` and supplies one.

## Related

[`@etherfold/server`](../../packages/server) for the routes and the wire contract, [`@etherfold/platform-nodejs-fetcher`](../nodejs-fetcher) for the OTHER Node deployable (the chain-facing half that pushes to a server like this one).

## Tests

`pnpm --filter @etherfold/platform-nodejs test`, vitest.
