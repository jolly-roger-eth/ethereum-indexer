---
'@etherfold/platform-nodejs': minor
'@etherfold/server': minor
'etherfold': minor
---

Adds the platform-agnostic indexer-server and its Node host, and a `serve` command to the CLI.

`@etherfold/server` is a Hono app that receives its database and environment by injection (`{getDB, getEnv}`) and imports no runtime: no Node built-ins, no Cloudflare types, no concrete driver. It ships the fixed-table schema and a `/status` route reporting database reachability, whether the schema is applied and at which version, and the last error this process saw. `POST /admin/setup` applies the schema. A test asserts the package names no runtime, so the property is checked rather than trusted.

`@etherfold/platform-nodejs` is the Node host: a libSQL-backed `RemoteSQL`, environment from the process, served over HTTP. It applies the schema at startup by default (one process owning one file), which `autoSetup: false` disables.

The CLI gains `etherfold serve`, which runs that host, so a project can start an indexer-server without wiring anything. `etherfold index` remains the default command, so existing `etherfold -p <processor> -f <folder>` invocations are unchanged.

A Cloudflare Worker host also exists, at `platforms/cf-worker`, and is not published: it is a deployable, not a library.

The server is a skeleton. It serves status and schema only: no chain logic, no store wiring, no feed. Those arrive with the tasks that follow ADR-0003.
