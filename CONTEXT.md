# CONTEXT — ethereum-indexer domain language

The domain glossary for `ethereum-indexer`. Agents and skills use THIS vocabulary when naming modules, tests, and discussing the system. Architectural rationale lives in `docs/adr/` (decisions); product framing lives in `work/specs/`.

## What ethereum-indexer is

A modular, TypeScript indexer for Ethereum and other EIP-1193 / JSON-RPC chains that turns a contract's event logs into a derived application **state** via a **processor**, and can run either fully in-browser (client-side indexing over EIP-1193, no server) or server-side. It supports reorgs, caching, and hydrating clients from pre-computed snapshots instead of indexing from scratch.

## Core domain terms

- **IndexingSource** — what to index: `chainId`, the contracts (`abi`, `address`, `startBlock`), optional `genesisHash`. Hashed into the sync context so a source change invalidates stale state.
- **EventProcessor** — the reducer contract the core drives: `load` / `process(eventStream, lastSync)` / `reset` / `clear` / `getVersionHash`. Given a stream of events, it produces the derived `ProcessResultType` state.
- **JSObjectEventProcessor** (the LIVE path) — the in-memory JS-object reducer authored via `fromJSProcessor(...)` (`on<EventName>` handlers). This is the production path used by stratagems-world → stratagems-snapshots and via `ethereum-indexer-browser`. Reorg revert is done here through `History.reverseBlock` (immer reverse-patches).
- **LogEvent** — a decoded (or parse-failed) log with block/tx coordinates; carries `removed: true` when an event is reorged out.
- **LastSync** — the sync cursor: `latestBlock`, `lastFromBlock`, `lastToBlock`, the `context` hashes, and `unconfirmedBlocks` (the recent, reorg-eligible window).
- **reorg / removed / finality** — the reorg model. `generateStreamToAppend` (core engine) shapes the fetched logs into an append stream, emitting `removed: true` markers for reorged-out blocks and pruning `unconfirmedBlocks` past the finality window. Processors consume that stream and revert-then-reapply. (Contract pinned by `packages/ethereum-indexer/test/utils.test.ts` and `packages/ethereum-indexer-js-processor/test/reorg.test.ts`.)
- **stream / keepStream (ExistingStream)** — the cached raw event stream seam, so a client can resume/re-derive without refetching all logs.
- **KeepState** — the persisted-state seam (`fetch`/`save`/`clear`) backing in-browser (IndexedDB/localStorage) and fs storage adapters; also how snapshots hydrate a client.
- **createAction** — the internal promise-serialization primitive in the core `EthereumIndexer` (`_index`/`_feed`/`_load`/`_save`) that keeps overlapping load/feed/index calls from interleaving.
- **work/ contract** — the on-disk system this repo uses, defined by the reference docs in **`work/protocol/`** (copied here by `setup`). Three REGIME umbrellas — `notes/` (capture buckets: `observations`/`ideas`/`findings`), `tasks/` (the build board: `backlog`/`ready`/`done`/`cancelled`), `specs/` (the spec lifecycle: `proposed`/`ready`/`tasked`/`dropped`) — plus top-level `questions/` and `protocol/`. One markdown file per item, status = the folder it lives in (never a field). ADRs (`docs/adr/`, format in `work/protocol/ADR-FORMAT.md`) record what WE decided and why.

## Conventions

Standing per-change rules agents must follow in this repo.

- Changes that affect a published package's public API require a **changeset** (`.changeset/*.md`).
- Logging goes through **named-logs** (`import {logs} from 'named-logs'`), not `console.*`, in the core `ethereum-indexer` package.
- Tests use **vitest**, in each package's `test/` folder; run via `pnpm --filter <pkg> test`.

<!-- Reproducibility: consider PINNING the dorfl version via `dorflCmd` in dorfl.json (JS repo: add `dorfl` to root devDependencies + `"dorflCmd": "node_modules/.bin/dorfl"`). See docs/dorfl-cmd/README.md. -->

## Skills this repo uses

- Required: `setup` (onboarding/migration), `to-spec`, `to-task`.
- Recommended: `review`, `grill-me`.
