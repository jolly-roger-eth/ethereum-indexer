# etherfold

The command line. `etherfold build` runs a processor over a chain and writes the derived state into a libSQL database; `etherfold serve` answers queries over a database written elsewhere.

```sh
npm i -g etherfold        # or: npx etherfold …
etherfold --help
```

Every run names its intent: there is no default command, so a bare `etherfold` prints this help and indexes nothing.

## When you want this, and when you do not

| you want | use |
| --- | --- |
| to index a contract into a database, from a terminal or a CI job | here |
| to index inside a browser tab, with no server | [`@etherfold/browser`](../browser) |
| to write the processor being run | [`@etherfold/processor-entities`](../processor-entities) |
| to embed the same pipeline in your own Node program | [`@etherfold/core`](../core) + [`@etherfold/fetcher-host`](../fetcher-host) |

## `etherfold build` -- one shot, to the tip, then exit

```sh
etherfold build \
  -p ./dist/processor.js \
  --store sqlite --db file:./etherfold.db \
  -n https://rpc.example
```

Named for what it PRODUCES: a database. What it does: load the processor module, open the store, resolve the source, then fetch and fold until it reaches the chain tip it observed, and exit. Exit code 0 on success, 1 on failure, so a CI job can depend on it.

**It is a ONE-SHOT and nothing else.** It does not follow the chain, does not stay up, and cannot be reconfigured while it runs: to keep a database current, run it again (a cron, a loop, a job). It resumes rather than restarting, because the sync cursor is in the store, written in the same transaction as the block it describes (ADR-0027). Live reconfiguration is the browser package's ability, not this one's.

| flag | |
| --- | --- |
| `-p, --processor <path>` | the processor module. It must export `createProcessor` (a factory, or the processor object itself) |
| `--store <sqlite>` | REQUIRED and never defaulted. It names where the state goes, and it is the axis a second backend would arrive on |
| `--db <url>` | libSQL url: `file:./etherfold.db`, `:memory:`, or `libsql://<host>`. Required with `--store sqlite`, so no run writes a database nobody named |
| `--retention <blocks\|revert-only\|unbounded>` | how far back superseded versions are kept, in BLOCK numbers and no other unit (ADR-0019). Default `unbounded` |
| `-d, --deployments <folder>` | contract deployments in hardhat-deploy / rocketh format, or `INDEXING_SOURCE` as JSON. Optional when the module supplies `contractsDataPerChain` |
| `-n, --node-url <url>` | the JSON-RPC endpoint (or `ETH_NODE_URI`) |
| `--rps <n>` | cap the requests per second made to the node (or `REQUESTS_PER_SECOND`) |

A flag combination that names no store is REFUSED rather than ignored: an accepted-and-ignored flag is a deployment believing a retention window is enforced, or a database is being written, when neither is true. Nothing prunes automatically, because pruning costs time proportional to what it drops and is a call a host schedules (ADR-0022).

The processor module hands back the AUTHORING object (declarations plus handlers) and never picks a store; that is what makes the SAME module file the one a browser tab runs. A module still returning the retired `{kind, processor}` tag is refused by name (ADR-0037).

## `etherfold serve` -- the READ tier

```sh
etherfold serve --db file:./etherfold.db --port 2000
```

**It only serves.** It holds no processor, makes no chain call, receives no logs and writes no indexed state: it answers queries over a database something ELSE wrote, so a serving tier can scale or move without carrying an indexer with it. Point it at a database `etherfold build` produced, or at one a log-fetcher is pushing into elsewhere.

It starts [`@etherfold/server`](../server) on Node through [`@etherfold/platform-nodejs`](../../platforms/nodejs): `GET /status` (health, schema version, reorg counters, last error) and `POST /admin/setup`. Because it hosts no ingestion, the write path is a CAPABILITY it does not have rather than a route it lacks: an authenticated call to `/ingest` answers `501 ingestion-not-configured` (an unauthenticated one answers `401`, so the absence of a processor is not something an anonymous caller can probe). `platforms/nodejs/test/serve.test.ts` asserts both.

The one thing it does write is the fixed-table SCHEMA, applied at startup if it is not already there, because the Node host is the single-operator case; `--no-auto-setup` turns that off and leaves migration to the operator.

| flag | |
| --- | --- |
| `--db <url>` | REQUIRED. The libSQL database to answer over (or `DB`). It is not defaulted, so a read tier never comes up on an empty database nobody named |
| `--port <port>` | port to listen on (or `PORT`). Defaults to `2000` |
| `--host <hostname>` | hostname to bind. Binds every interface when absent |
| `--no-auto-setup` | do not apply the fixed-table schema at startup |

The server's dependency tree is imported lazily, so `etherfold build` never pays for it.

## Configuration: flags first, environment behind them

Every command resolves every input THE SAME WAY, which is what makes moving between them a deployment change rather than a rewrite. The rules:

- **A flag beats the environment**, the environment is used when the flag is absent, and neither present is a REFUSAL. Only the port falls back to a default (`2000`); nothing else does, because getting a database or a node URL wrong silently is how a deployment ends up believing something untrue.
- **One name per input**, and the variables are the ones a deployable already publishes: the fetcher host's (`INDEXING_SOURCE`, `ETH_NODE_URI`, `INGEST_ENDPOINT`, `INGEST_TOKEN`, `REQUESTS_PER_SECOND`) plus the Node server host's (`DB`, `PORT`).
- **A refusal names the flag AND the variable** that would have satisfied it, and it happens before the chain is dialled or a database is opened.
- **Nothing is accepted and ignored.** A flag a command does not own is refused with the reason it does not own it (`etherfold serve -p ./processor.js` says that a read tier holds no processor and points at `index` / `run` / `build`), rather than being taken and quietly having no effect. An ambient VARIABLE a command does not own is simply not read, so one host can run several commands side by side.

Six inputs have a variable and six do not, and the line is deliberate: **the environment carries what varies between deployments of one image** -- the chain, the source, the database, the wire, the port -- while a flag carries what the image IS: which processor module, which store, which retention window, which interface.

| variable | flag | |
| --- | --- | --- |
| `INDEXING_SOURCE` | `-d, --deployments` | what to index, as JSON (`{chainId, contracts}`) where the flag is a deployments folder |
| `ETH_NODE_URI` | `-n, --node-url` | the chain's JSON-RPC endpoint |
| `DB` | `--db` | the libSQL database |
| `PORT` | `--port` | the port an HTTP surface binds |
| `INGEST_ENDPOINT` | `--ingest-endpoint` | the indexer-server a `fetch` pushes to |
| `INGEST_TOKEN` | `--ingest-token` | the ingest wire's shared secret, the same name on both sides. Prefer the variable: a secret on a command line is visible to every process on the host |
| `REQUESTS_PER_SECOND` | `--rps` | the rate limit applied to the node |

The CLI used to read a second name for the node URL (`ETHEREUM_NODE`). It is RETIRED: there is one name for it, and it is `ETH_NODE_URI`, which is what the fetcher deployable already refuses by.

## The command names are going to grow

`build` and `serve` are what ships today, and they are two of the five names the set will have. The other three (`run` follows the chain, folds and answers queries without terminating; `fetch` is the stateless chain-facing half that pushes to a remote; `index` is the folding half that receives those pushes and owns the database) are decided in `work/specs/tasked/one-command-runs-the-whole-pipeline.md` and NOT built. `CONTEXT.md` is the authority for what each name means. Nothing resolves to them yet: `etherfold index` is an unknown command until the receiver lands.

Their CONFIGURATION, though, already resolves: all five rows live in one table (`src/config.ts`), including the two asymmetries that make the set work. `fetch` takes a source but no processor, and refuses `--store` and `--db` outright, because the chain-facing half holds no state (ADR-0003). `index` resolves its source with NO chain call at all, so it takes it from `-d` or `INDEXING_SOURCE` and refuses a processor module that could only be resolved by asking a node for its chain id. So adding one of the three is a command registration and an assembly, never a second way to read a flag.

## Tests

`pnpm --filter etherfold test`, vitest.
