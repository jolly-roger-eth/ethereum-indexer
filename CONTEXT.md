# CONTEXT — etherfold domain language

The domain glossary for `etherfold`. Agents and skills use THIS vocabulary when naming modules, tests, and discussing the system. Architectural rationale lives in `docs/adr/` (decisions); product framing lives in `work/specs/`.

## What etherfold is

A modular, TypeScript indexer for Ethereum and other EIP-1193 / JSON-RPC chains that turns a contract's event logs into a derived application **state** via a **processor**, and can run either fully in-browser (client-side indexing over EIP-1193, no server) or server-side. It supports reorgs, caching, and hydrating clients from pre-computed snapshots instead of indexing from scratch.

## Core domain terms

- **IndexingSource** — what to index: `chainId`, the contracts (`abi`, `address`, `startBlock`), optional `genesisHash`. Hashed into the sync context so a source change invalidates stale state.
- **EventProcessor** — the reducer contract the core drives: `load` / `process(eventStream, lastSync)` / `reset` / `clear` / `getVersionHash`. Given a stream of events, it produces the derived `ProcessResultType` state.
- **JSObjectEventProcessor** (the LIVE path) — the in-memory JS-object reducer authored via `fromJSProcessor(...)` (`on<EventName>` handlers). This is the production path used by stratagems-world → stratagems-snapshots and via `@etherfold/browser`. Reorg revert is done here through `History.reverseBlock` (immer reverse-patches).
- **LogEvent** — a decoded (or parse-failed) log with block/tx coordinates; carries `removed: true` when an event is reorged out.
- **LastSync** — the sync cursor: `latestBlock`, `lastFromBlock`, `lastToBlock`, the `context` hashes, and `unconfirmedBlocks` (the recent, reorg-eligible window).
- **reorg / removed / finality** — the reorg model. `generateStreamToAppend` (core engine) shapes the fetched logs into an append stream, emitting `removed: true` markers for reorged-out blocks and pruning `unconfirmedBlocks` past the finality window. Processors consume that stream and revert-then-reapply. (Contract pinned by `packages/core/test/utils.test.ts` and `packages/js-processor/test/reorg.test.ts`.)
- **stream / keepStream (ExistingStream)** — the cached raw event stream seam, so a client can resume/re-derive without refetching all logs.
- **StateStore** (the STORAGE SEAM, `@etherfold/state-store`) — what a store must do for a processor to run on it: `migrate` / `applyBlock` / `getCurrent` / `getAsOf` / `revertTo`, plus the capabilities it declares. Implemented by `@etherfold/state-store-sqlite` (versioned rows over `remote-sql`) and by `MemoryStateStore` (the reference implementation). Block addressing by hash or time, and any richer query surface, sit ABOVE the seam and are a backend's own.
- **entity declaration** — `{name, id, fields}`, the whole per-entity contract an author writes. The store owns everything else: the layout, the version columns, the as-of read and the reorg revert.
- **version** — one COMPLETE row of an entity with a half-open block-validity range (`_lower` inclusive, `_upper` exclusive, NULL meaning live). `set` writes a whole row, so an unlisted declared field becomes NULL; `delete` closes the live version without opening a new one.
- **MutationContext** — the write surface a handler gets for ONE block (`get` / `set` / `delete`, plus `update` as sugar over get-then-spread-then-set), with read-your-writes inside that block. Uniformly async on every backend.
- **EntityProcessor** (`@etherfold/processor-entities`) — a processor written against the seam: entity declarations plus `on<EventName>` handlers over a `MutationContext`, naming no backend. `JSObjectEventProcessor` is the same role over a free-form object.
- **retention** — how far back superseded versions are kept, measured in BLOCK NUMBERS and in no other unit. Its floor is the finality depth, because reorg revert already requires that much. Reported as a capability (`revert-only`, a window of N blocks, or `unbounded`), so a caller discovers at startup what history is available instead of from a wrong answer.
- **KeepState** — the persisted-state seam (`fetch`/`save`/`clear`) backing in-browser (IndexedDB/localStorage) and fs storage adapters; also how snapshots hydrate a client.
- **createAction** — the internal promise-serialization primitive in the core `EthereumIndexer` (`_index`/`_feed`/`_load`/`_save`) that keeps overlapping load/feed/index calls from interleaving.
- **work/ contract** — the on-disk system this repo uses, defined by the reference docs in **`work/protocol/`** (copied here by `setup`). Three REGIME umbrellas — `notes/` (capture buckets: `observations`/`ideas`/`findings`), `tasks/` (the build board: `backlog`/`ready`/`done`/`cancelled`), `specs/` (the spec lifecycle: `proposed`/`ready`/`tasked`/`dropped`) — plus top-level `questions/` and `protocol/`. One markdown file per item, status = the folder it lives in (never a field). ADRs (`docs/adr/`, format in `work/protocol/ADR-FORMAT.md`) record what WE decided and why.

## Server-side architecture terms

The planned server-side split (decided in `docs/adr/0003`-`0008`; not built yet). "Processor" keeps the meaning defined above (`EventProcessor` / `JSObjectEventProcessor`, the reducer) and is NOT the name of a deployable.

- **log-fetcher**: stateless, chain-facing. Calls `eth_getLogs` and pushes contiguous block ranges of raw logs. Holds no cursor, no unconfirmed window, no reorg logic, so it can be restarted or replaced freely.
- **stream-builder**: receives those ranges, is authoritative about where the next one must start (`expectedFromBlock`), derives reorgs, and owns the stored **emission stream** (append-only, retractions included). Keyed by `{source, config}`.
- **indexer-server**: the deployable hosting the stream-builder plus an `EventProcessor`, owning the versioned state (keyed by `{source, config, processor}`) and serving both the state query API and the log feed.
- **consumer**: anything reading the feed (a trigger/notification service). Independent, owns its own cursor, gate, outbox and delivery; the indexer-server stores nothing about it. Reserve "consumer" for this read side and never call it a watcher.
- **gate / lane**: the block bound a consumer applies before acting: `safe` (finalized) or `fast` (`latestBlock - N`, per chain, defaulting to `stream.finality`).

## Conventions

Standing per-change rules agents must follow in this repo.

- Changes that affect a published package's public API require a **changeset** (`.changeset/*.md`).
- Logging goes through **named-logs** (`import {logs} from 'named-logs'`), not `console.*`, in the core `@etherfold/core` package.
- Tests use **vitest**, in each package's `test/` folder; run via `pnpm --filter <pkg> test`.
- **`pnpm typecheck` is what checks `test/`.** Each package's build `tsconfig.json` includes `src/**/*.ts` only (it emits to `dist/`, so tests must stay out of it), and vitest strips types with esbuild without checking them. The per-package `tsconfig.typecheck.json` (`noEmit`, `rootDir: "."`, `src/**/*.ts` + `test/**/*.ts`) is the only thing that typechecks a test file. **Run `pnpm build` first**: cross-package types resolve through each package's `dist/`, so `pnpm typecheck` on a clean clone reports missing modules. The acceptance gate already sequences them that way (`pnpm build && pnpm typecheck && pnpm test`).

<!-- Reproducibility: consider PINNING the dorfl version via `dorflCmd` in dorfl.json (JS repo: add `dorfl` to root devDependencies + `"dorflCmd": "node_modules/.bin/dorfl"`). See docs/dorfl-cmd/README.md. -->

## Skills this repo uses

- Required: `setup` (onboarding/migration), `to-spec`, `to-task`.
- Recommended: `review`, `grill-me`.
