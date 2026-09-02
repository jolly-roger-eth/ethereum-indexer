# etherfold

The command line. `etherfold index` runs a processor over a chain and writes the derived state into a libSQL database; `etherfold serve` puts the indexer-server in front of one.

```sh
npm i -g etherfold        # or: npx etherfold …
etherfold --help
```

## When you want this, and when you do not

| you want | use |
| --- | --- |
| to index a contract into a database, from a terminal or a CI job | here |
| to index inside a browser tab, with no server | [`@etherfold/browser`](../browser) |
| to write the processor being run | [`@etherfold/processor-entities`](../processor-entities) |
| to embed the same pipeline in your own Node program | [`@etherfold/core`](../core) + [`@etherfold/fetcher-host`](../fetcher-host) |

## `etherfold index` -- one shot, to the tip, then exit

```sh
etherfold index \
  -p ./dist/processor.js \
  --store sqlite --db file:./etherfold.db \
  -n https://rpc.example
```

It is the DEFAULT command, so the flags work with the verb omitted. What it does: load the processor module, open the store, resolve the source, then fetch and fold until it reaches the chain tip it observed, and exit. Exit code 0 on success, 1 on failure, so a CI job can depend on it.

**It is a ONE-SHOT and nothing else.** It does not follow the chain, does not stay up, and cannot be reconfigured while it runs: to keep a database current, run it again (a cron, a loop, a job). It resumes rather than restarting, because the sync cursor is in the store, written in the same transaction as the block it describes (ADR-0027). Live reconfiguration is the browser package's ability, not this one's.

| flag | |
| --- | --- |
| `-p, --processor <path>` | the processor module. It must export `createProcessor` (a factory, or the processor object itself) |
| `--store <sqlite>` | REQUIRED and never defaulted. It names where the state goes, and it is the axis a second backend would arrive on |
| `--db <url>` | libSQL url: `file:./etherfold.db`, `:memory:`, or `libsql://<host>`. Required with `--store sqlite`, so no run writes a database nobody named |
| `--retention <blocks\|revert-only\|unbounded>` | how far back superseded versions are kept, in BLOCK numbers and no other unit (ADR-0019). Default `unbounded` |
| `-d, --deployments <folder>` | contract deployments in hardhat-deploy / rocketh format. Optional when the module supplies `contractsData` or `contractsDataPerChain` |
| `-n, --node-url <url>` | the JSON-RPC endpoint (falls back to `ETHEREUM_NODE`) |
| `--rps <n>` | cap the requests per second made to the node |

A flag combination that names no store is REFUSED rather than ignored: an accepted-and-ignored flag is a deployment believing a retention window is enforced, or a database is being written, when neither is true. Nothing prunes automatically, because pruning costs time proportional to what it drops and is a call a host schedules (ADR-0022).

The processor module hands back the AUTHORING object (declarations plus handlers) and never picks a store; that is what makes the SAME module file the one a browser tab runs. A module still returning the retired `{kind, processor}` tag is refused by name (ADR-0037).

## `etherfold serve` -- the HTTP tier

```sh
etherfold serve --db file:./etherfold.db --port 2000
```

Starts [`@etherfold/server`](../server) on Node through [`@etherfold/platform-nodejs`](../../platforms/nodejs): `GET /status` (health, schema version, reorg counters, last error) and `POST /admin/setup` (apply the fixed-table schema; done automatically at startup unless `--no-auto-setup`). It hosts no processor, so ingestion answers `501`: it serves a database written by `index` or pushed to by a log-fetcher elsewhere.

The server's dependency tree is imported lazily, so `etherfold index` never pays for it.

## The command names are going to grow

`index` and `serve` are what ships today. The target set (`run` follows the chain and answers queries, `build` does the same and exits, `fetch` and `index` are the two halves of a split deployment, `serve` answers queries only) is decided in `work/specs/ready/one-command-runs-the-whole-pipeline.md` and NOT built. Where a document in this repo uses those names, it is describing that target; this README describes the binary.

## Tests

`pnpm --filter etherfold test`, vitest.
