# ethereum-indexer-server

## Unreleased, and never will be

This package retired under ADR-0010 before these changes were released, and it moved to `archive/` outside the workspace. The entries below were pending changesets in `.changeset/`; they are transcribed here rather than deleted, because a changeset naming a package that is not in the workspace makes `changeset status`, `changeset version` and any release fail outright. There is no version to publish them under. See `archive/README.md`.

### Patch Changes

- Rewrite `setupIndexing()` to use the new shared `resolveProcessorAndSource` helper from `@etherfold/utils` instead of its own copy of the processor-module loading / contract-data / source-resolution logic (LOW-4 in the server/CLI batch audit). Behaviour is preserved: the server still owns its provider construction (including the `createProvider` seam) and its caching (`useCache` / `useFSCache`) and `EthereumIndexer` wiring, and still passes its `folder` as the processor factory argument (now expressed explicitly via the helper's `processorConfig` parameter).

- Harden the server HTTP surface (low-severity fixes):

  - Routes that hit a not-ready server (`no indexer` / `no processor` / cache disabled) now return a shaped `503` `{error:{code,message}}` body instead of throwing, which Koa turned into a `500` (potentially leaking a stack trace). The mutating routes keep their existing `{error:{code}}` shape.
  - The API-key check now uses a constant-time comparison (`crypto.timingSafeEqual`) instead of `Array.includes`, so response timing does not leak the key. Behaviour is otherwise unchanged (valid keys authorize, invalid keys are rejected).

- Make the server's indexing more robust and observable:

  - **Exponential backoff on auto-index errors.** The auto-index loop previously retried every 1s forever on failure and logged at `info`. It now backs off exponentially (1s → 2s → 4s … capped at 60s), resets on success, and logs at `error`.
  - **Surface the last error in the `/` status.** A failing/stuck server reported `indexing: true` with no indication of trouble. The `/` response now includes a `lastError` (`{message, at}`) so operators can see the loop is failing.
  - **Serialize all indexing entrypoints.** The auto-index loop, manual `/indexMore`, `/feed` and `/replay` now go through a single in-flight guard, so two indexing operations never run concurrently on the same indexer instance (previously two concurrent `/indexMore` calls could race, and `/feed`/`/replay` were not guarded against an in-flight manual `/indexMore`).

- Fix the `/feed` route reading the request body from the wrong place. It read `ctx.body.events` (the response body, always `undefined` here) instead of `ctx.request.body.events`, so every real `/feed` call threw `Cannot read properties of undefined (reading 'events')` and the route was effectively dead. It now reads the `events` array from the request body, validates it is an array (returning a shaped `{error:{code:4000}}` Bad Request instead of throwing a 500 when it is missing/not an array), and forwards it to `indexer.feed`.

  Also adds an optional `createProvider?: (nodeURL) => provider` factory to the server config (defaults to the existing `new JSONRPCHTTPProvider(nodeURL)`, so behaviour is unchanged when omitted; useful for injecting a custom provider or a fake in tests), and makes the admin page template load lazily instead of at module import time.

- Shared with the packages that were renamed, and released only under their new names: the ESM-only `tsc` build, the viem v2 dependency update, the published-type-dependency fix and the `isBigIntLiteral` / `simple_hash` guard. Those changesets kept their other packages and simply stopped naming this one.

## 0.6.32

### Patch Changes

- Updated dependencies
  - ethereum-indexer-utils@0.6.13

## 0.6.31

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.21
  - ethereum-indexer-db-utils@0.6.21
  - ethereum-indexer-fs-cache@0.6.21
  - ethereum-indexer-utils@0.6.12

## 0.6.30

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.20
  - ethereum-indexer-db-utils@0.6.20
  - ethereum-indexer-fs-cache@0.6.20
  - ethereum-indexer-utils@0.6.12

## 0.6.29

### Patch Changes

- Updated dependencies
  - ethereum-indexer-utils@0.6.12

## 0.6.28

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.19
  - ethereum-indexer-db-utils@0.6.19
  - ethereum-indexer-fs-cache@0.6.19
  - ethereum-indexer-utils@0.6.11

## 0.6.27

### Patch Changes

- make of eip-1193-jsonrpc-provider new name

## 0.6.26

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.18
  - ethereum-indexer-db-utils@0.6.18
  - ethereum-indexer-fs-cache@0.6.18
  - ethereum-indexer-utils@0.6.11

## 0.6.25

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.17
  - ethereum-indexer-db-utils@0.6.17
  - ethereum-indexer-fs-cache@0.6.17
  - ethereum-indexer-utils@0.6.11

## 0.6.24

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.16
  - ethereum-indexer-db-utils@0.6.16
  - ethereum-indexer-fs-cache@0.6.16
  - ethereum-indexer-utils@0.6.11

## 0.6.23

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.15
  - ethereum-indexer-db-utils@0.6.15
  - ethereum-indexer-fs-cache@0.6.15
  - ethereum-indexer-utils@0.6.11

## 0.6.22

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.14
  - ethereum-indexer-db-utils@0.6.14
  - ethereum-indexer-fs-cache@0.6.14
  - ethereum-indexer-utils@0.6.11

## 0.6.21

### Patch Changes

- Updated dependencies
  - ethereum-indexer-utils@0.6.11
  - ethereum-indexer@0.6.13
  - ethereum-indexer-db-utils@0.6.13
  - ethereum-indexer-fs-cache@0.6.13

## 0.6.20

### Patch Changes

- add rps for cli

## 0.6.19

### Patch Changes

- use latest deps

## 0.6.18

### Patch Changes

- latest deps
- Updated dependencies
  - ethereum-indexer-db-utils@0.6.12
  - ethereum-indexer-fs-cache@0.6.12
  - ethereum-indexer-utils@0.6.10
  - ethereum-indexer@0.6.12

## 0.6.17

### Patch Changes

- Updated dependencies
  - ethereum-indexer-utils@0.6.9

## 0.6.16

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.11
  - ethereum-indexer-db-utils@0.6.11
  - ethereum-indexer-fs-cache@0.6.11
  - ethereum-indexer-utils@0.6.8

## 0.6.15

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.10
  - ethereum-indexer-db-utils@0.6.10
  - ethereum-indexer-fs-cache@0.6.10
  - ethereum-indexer-utils@0.6.8

## 0.6.14

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.9
  - ethereum-indexer-db-utils@0.6.9
  - ethereum-indexer-fs-cache@0.6.9
  - ethereum-indexer-utils@0.6.8

## 0.6.13

### Patch Changes

- reorg + add streams server (wip)
- Updated dependencies
  - ethereum-indexer-db-utils@0.6.8
  - ethereum-indexer-fs-cache@0.6.8
  - ethereum-indexer@0.6.8
  - ethereum-indexer-utils@0.6.8

## 0.6.12

### Patch Changes

- fixes for ethereum-indexer-server port handling

## 0.6.11

### Patch Changes

- add port config

## 0.6.10

### Patch Changes

- improve processor import to work in pnpm + startBlock fix
- Updated dependencies
  - ethereum-indexer-db-utils@0.6.7
  - ethereum-indexer-fs-cache@0.6.7
  - ethereum-indexer@0.6.7

## 0.6.9

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.6
  - ethereum-indexer-db-utils@0.6.6
  - ethereum-indexer-fs-cache@0.6.6

## 0.6.8

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.5
  - ethereum-indexer-db-utils@0.6.5
  - ethereum-indexer-fs-cache@0.6.5

## 0.6.7

### Patch Changes

- Updated dependencies [c81fb4d]
  - ethereum-indexer@0.6.4
  - ethereum-indexer-db-utils@0.6.4
  - ethereum-indexer-fs-cache@0.6.4

## 0.6.6

### Patch Changes

- forgot to build before release

## 0.6.5

### Patch Changes

- use ldenv

## 0.6.4

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.3
  - ethereum-indexer-db-utils@0.6.3
  - ethereum-indexer-fs-cache@0.6.3

## 0.6.3

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.2
  - ethereum-indexer-db-utils@0.6.2
  - ethereum-indexer-fs-cache@0.6.2

## 0.6.2

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.1
  - ethereum-indexer-db-utils@0.6.1
  - ethereum-indexer-fs-cache@0.6.1

## 0.6.1

### Patch Changes

- make use of eip-1993-json-provider

## 0.6.0

### Minor Changes

- release

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.0
  - ethereum-indexer-db-utils@0.6.0
  - ethereum-indexer-fs-cache@0.6.0
  - ethereum-indexer-utils@0.6.0

## 0.5.6

### Patch Changes

- fixes
- Updated dependencies
  - ethereum-indexer@0.5.6
  - ethereum-indexer-db-processors@0.5.6
  - ethereum-indexer-fs-cache@0.5.6
  - ethereum-indexer-utils@0.5.6

## 0.5.5

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.5.5
  - ethereum-indexer-db-processors@0.5.5
  - ethereum-indexer-fs-cache@0.5.5
  - ethereum-indexer-utils@0.5.5

## 0.5.4

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.5.4
  - ethereum-indexer-db-processors@0.5.4
  - ethereum-indexer-fs-cache@0.5.4
  - ethereum-indexer-utils@0.5.4

## 0.5.3

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.5.3
  - ethereum-indexer-db-processors@0.5.3
  - ethereum-indexer-fs-cache@0.5.3
  - ethereum-indexer-utils@0.5.3

## 0.5.2

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.5.2
  - ethereum-indexer-db-processors@0.5.2
  - ethereum-indexer-fs-cache@0.5.2
  - ethereum-indexer-utils@0.5.2

## 0.5.1

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.5.1
  - ethereum-indexer-db-processors@0.5.1
  - ethereum-indexer-fs-cache@0.5.1
  - ethereum-indexer-utils@0.5.1

## 0.5.0

### Minor Changes

- use viem + aitype for type-safe experience

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.5.0
  - ethereum-indexer-db-processors@0.5.0
  - ethereum-indexer-fs-cache@0.5.0
  - ethereum-indexer-utils@0.5.0

## 0.4.3

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.4.3
  - ethereum-indexer-db-processors@0.4.3
  - ethereum-indexer-fs-cache@0.4.3
  - ethereum-indexer-utils@0.4.3

## 0.4.2

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.4.2
  - ethereum-indexer-db-processors@0.4.2
  - ethereum-indexer-fs-cache@0.4.2
  - ethereum-indexer-utils@0.4.2

## 0.4.1

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.4.1
  - ethereum-indexer-db-processors@0.4.1
  - ethereum-indexer-fs-cache@0.4.1
  - ethereum-indexer-utils@0.4.1

## 0.4.0

### Minor Changes

- chainId specified

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.4.0
  - ethereum-indexer-db-processors@0.4.0
  - ethereum-indexer-fs-cache@0.4.0
  - ethereum-indexer-utils@0.4.0

## 0.3.12

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.3.11
  - ethereum-indexer-db-processors@0.3.12
  - ethereum-indexer-fs-cache@0.3.12
  - ethereum-indexer-utils@0.3.11

## 0.3.11

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.3.10
  - ethereum-indexer-db-processors@0.3.11
  - ethereum-indexer-fs-cache@0.3.11
  - ethereum-indexer-utils@0.3.10

## 0.3.10

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.3.9
  - ethereum-indexer-db-processors@0.3.10
  - ethereum-indexer-fs-cache@0.3.10
  - ethereum-indexer-utils@0.3.9

## 0.3.9

### Patch Changes

- typings
- Updated dependencies
  - ethereum-indexer@0.3.8
  - ethereum-indexer-utils@0.3.8
  - ethereum-indexer-db-processors@0.3.9
  - ethereum-indexer-fs-cache@0.3.9

## 0.3.8

### Patch Changes

- types
- Updated dependencies
  - ethereum-indexer@0.3.7
  - ethereum-indexer-utils@0.3.7
  - ethereum-indexer-db-processors@0.3.8
  - ethereum-indexer-fs-cache@0.3.8

## 0.3.7

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.3.6
  - ethereum-indexer-db-processors@0.3.7
  - ethereum-indexer-fs-cache@0.3.7
  - ethereum-indexer-utils@0.3.6

## 0.3.6

### Patch Changes

- use eip-1193 types
- Updated dependencies
  - ethereum-indexer@0.3.5
  - ethereum-indexer-db-processors@0.3.6
  - ethereum-indexer-fs-cache@0.3.6
  - ethereum-indexer-utils@0.3.5

## 0.3.5

### Patch Changes

- force new version
- Updated dependencies
  - ethereum-indexer@0.3.4
  - ethereum-indexer-db-processors@0.3.5
  - ethereum-indexer-fs-cache@0.3.5
  - ethereum-indexer-utils@0.3.4

## 0.3.4

### Patch Changes

- republish with new types
- Updated dependencies
  - ethereum-indexer@0.3.3
  - ethereum-indexer-db-processors@0.3.4
  - ethereum-indexer-fs-cache@0.3.4
  - ethereum-indexer-utils@0.3.3

## 0.3.3

### Patch Changes

- Updated dependencies
  - ethereum-indexer-db-processors@0.3.3
  - ethereum-indexer-fs-cache@0.3.3

## 0.3.2

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.3.2
  - ethereum-indexer-db-processors@0.3.2
  - ethereum-indexer-fs-cache@0.3.2
  - ethereum-indexer-utils@0.3.2

## 0.3.1

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.3.1
  - ethereum-indexer-db-processors@0.3.1
  - ethereum-indexer-fs-cache@0.3.1
  - ethereum-indexer-utils@0.3.1

## 0.3.0

### Minor Changes

- new release

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.3.0
  - ethereum-indexer-db-processors@0.3.0
  - ethereum-indexer-fs-cache@0.3.0
  - ethereum-indexer-utils@0.3.0

## 0.2.17

### Patch Changes

- fix dep

## 0.2.15

### Patch Changes

- use monorepo
- Updated dependencies
  - ethereum-indexer@0.0.15
