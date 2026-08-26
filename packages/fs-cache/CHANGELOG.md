# ethereum-indexer-fs-event-store

## 0.7.0

### Minor Changes

- 047cd73: Switch the build from `tsup` to `tsc` and ship ESM-only output. The CommonJS build (`dist/*.cjs`) and the `main` field have been removed; packages are now consumed via the `module`/`exports` ESM entrypoints only. Module resolution moves to `NodeNext` (relative imports now carry explicit `.js` extensions, JSON imports use import attributes).
- bc5d71a: Update all dependencies to their latest versions and fix the resulting build.

  Dependency updates (notable):
  - `viem` 1.x → `^2.52.0` (major), `abitype` → `^1.2.4`
  - `pouchdb` / `pouchdb-find` → `^9.0.0`, `commander` → `^15.0.0`, `koa` → `^3.2.1`
  - `typescript` → `^6.0.3`, `vitest` → `^4.1.8`, plus various `@types/*`, `eip-1193`, `named-logs`, `fs-extra`, etc.

  Fixes required by the updates:
  - `@etherfold/core`: handle viem v2's stricter `encodeEventTopics` return type (`(Hex | Hex[] | null)[]`) and the generic `eventName` returned by `decodeEventLog` over `AbiEvent[]`.
  - `@etherfold/browser`: align `LastSync`/`ExistingStream` generic vs. base `Abi` usage that broke under viem v2's tighter `DecodeEventLogReturnType`.
  - `@etherfold/fs-cache`: spread typed event args safely; make the package explicitly ESM (`type: module`) with `.js` import extensions.
  - All published packages: add a standard `exports` map (ESM-only, no `main`) so modern bundlers/test runners (Vite/Vitest v4) resolve the package entry correctly.

  JS processor authoring keeps full ABI-derived type safety (`event.args` typed from the ABI).

- e0e5832: Renamed to the `@etherfold` scope (ADR-0017). `ethereum-indexer` is now `@etherfold/core`, and `ethereum-indexer-browser`, `-js-processor`, `-fs`, `-fs-cache` and `-utils` are now `@etherfold/browser`, `@etherfold/js-processor`, `@etherfold/fs`, `@etherfold/fs-cache` and `@etherfold/utils`. The two previously unpublished `@ethereum-indexer/*` packages move to `@etherfold/*`.

  The CLI is the one exception to the scope: `ethereum-indexer-cli` becomes the flat package **`etherfold`**, because it is the package that installs the `etherfold` command.

  No API changed: update the package name in your imports and the exports are identical.

  **You must migrate to keep receiving updates.** There is no re-export shim under the old names, so nothing further will be published as `ethereum-indexer*` and no version of an old name forwards to the new one. Already-published versions stay installable indefinitely, so existing pins keep resolving, but they are frozen.

  **The CLI command is renamed**: the CLI installs `etherfold` instead of `ei`, so `npm i -g etherfold` then `etherfold -p <processor>`. Update any script that shells out to `ei`.

  `named-logs` namespaces follow the package names, so any log filter matching `ethereum-indexer*` needs updating to `@etherfold/*`. The CLI is the exception: its namespaces follow the command, so `ei` and `ei:keepState` become `etherfold` and `etherfold:keepState`.

  `ethereum-indexer-server` and `ethereum-indexer-db-utils` are deliberately NOT renamed: both are on the retirement path set by ADR-0010, and they have since moved to `archive/` in the repository, outside the workspace. Their published versions stay installable and are not deprecated here.

### Patch Changes

- 33afc5b: A processor's `version` is now REQUIRED, and the indexer reports when the declared version no longer matches the code.

  **Breaking for processor authors, in both authoring surfaces.** `version` becomes a required field on `JSProcessor` (`@etherfold/js-processor`) and on `SQLProcessor` (`@etherfold/processor-sqlite`), and a processor without a non-empty one now throws at construction, naming the processor by its handlers. Add a `version` to each processor object, ideally generated (as `examples/event-processor-nfts` does, from a hash of its own built file) so it cannot be forgotten.

  **Breaking for `EventProcessor` implementors.** `getCodeFingerprint(): string | undefined` is a REQUIRED method, not an optional one. An optional method would be a hole with a polite name: an implementation that never wrote one, or a wrapper that forgot to forward it, would lose drift detection with nothing to show for it. Returning `undefined` is still a valid answer and means "cannot tell", which is never reported as drift. Both cache wrappers (`EventCache`, `ProcessorFilesystemCache`) forward it.

  **Breaking for stored state: every version hash changes, so existing state is discarded once.** Both implementations dropped their fallback constants entirely rather than merely making them unreachable. `${version || 'unknown'}` is gone with the optional version, and `configHash || 'not-configured'` is gone too: the config is now hashed the same way whether or not `configure()` was called, so an unconfigured processor and one configured with `undefined` no longer get different hashes and no longer discard each other's state.

  **New: advisory drift detection for the version an author forgot to bump.** `getCodeFingerprint()` is derived from the processor's own handler sources and persisted as `LastSync.context.processorFingerprint`. On load, when the version hash is UNCHANGED but the fingerprint is not, the core reports at error level through `named-logs` and through a new `indexer.onProcessorDrift` callback, and keeps going. Set `strictProcessorDrift: true` in the indexer config to refuse to start instead.
  - The fingerprint is deliberately NOT part of `getVersionHash()`. A minifier or a transpiler change moves it without changing behaviour, and folding that in would force a full state rebuild on a deploy that changed no logic.
  - **Absence is never drift.** A cursor with no fingerprint, and a processor that answers `undefined`, both report nothing.
  - `processorCodeFingerprint(processor)` and `assertProcessorVersion(processor, implementation)` are exported from `@etherfold/core` for anyone implementing their own `EventProcessor`.
  - `ProcessorContext.version` is now required, since every processor has one.

- Updated dependencies [6c875dd]
- Updated dependencies [535ccc1]
- Updated dependencies [0957f8c]
- Updated dependencies [c681b79]
- Updated dependencies [9d21d67]
- Updated dependencies [ca6f981]
- Updated dependencies [31833b6]
- Updated dependencies [047cd73]
- Updated dependencies [eba61c3]
- Updated dependencies [dece521]
- Updated dependencies [939364a]
- Updated dependencies [d24872f]
- Updated dependencies [78d8377]
- Updated dependencies [3de4c35]
- Updated dependencies [bc118e4]
- Updated dependencies [bc5d71a]
- Updated dependencies [e0a6480]
- Updated dependencies [9738f1c]
- Updated dependencies [33afc5b]
- Updated dependencies [4097ccd]
- Updated dependencies [e0e5832]
- Updated dependencies [3a78285]
- Updated dependencies [0ac08c0]
- Updated dependencies [cefe0de]
  - @etherfold/core@0.7.0

## 0.6.21

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.21

## 0.6.20

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.20

## 0.6.19

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.19

## 0.6.18

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.18

## 0.6.17

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.17

## 0.6.16

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.16

## 0.6.15

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.15

## 0.6.14

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.14

## 0.6.13

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.13

## 0.6.12

### Patch Changes

- latest deps
- Updated dependencies
  - ethereum-indexer@0.6.12

## 0.6.11

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.11

## 0.6.10

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.10

## 0.6.9

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.9

## 0.6.8

### Patch Changes

- reorg + add streams server (wip)
- Updated dependencies
  - ethereum-indexer@0.6.8

## 0.6.7

### Patch Changes

- improve processor import to work in pnpm + startBlock fix
- Updated dependencies
  - ethereum-indexer@0.6.7

## 0.6.6

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.6

## 0.6.5

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.5

## 0.6.4

### Patch Changes

- Updated dependencies [c81fb4d]
  - ethereum-indexer@0.6.4

## 0.6.3

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.3

## 0.6.2

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.2

## 0.6.1

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.1

## 0.6.0

### Minor Changes

- release

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.0

## 0.5.6

### Patch Changes

- fixes
- Updated dependencies
  - ethereum-indexer@0.5.6

## 0.5.5

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.5.5

## 0.5.4

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.5.4

## 0.5.3

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.5.3

## 0.5.2

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.5.2

## 0.5.1

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.5.1

## 0.5.0

### Minor Changes

- use viem + aitype for type-safe experience

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.5.0

## 0.4.3

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.4.3

## 0.4.2

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.4.2

## 0.4.1

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.4.1

## 0.4.0

### Minor Changes

- chainId specified

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.4.0

## 0.3.12

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.3.11

## 0.3.11

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.3.10

## 0.3.10

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.3.9

## 0.3.9

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.3.8

## 0.3.8

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.3.7

## 0.3.7

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.3.6

## 0.3.6

### Patch Changes

- use eip-1193 types
- Updated dependencies
  - ethereum-indexer@0.3.5

## 0.3.5

### Patch Changes

- force new version
- Updated dependencies
  - ethereum-indexer@0.3.4

## 0.3.4

### Patch Changes

- republish with new types
- Updated dependencies
  - ethereum-indexer@0.3.3

## 0.3.3

### Patch Changes

- fix export types again

## 0.3.2

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.3.2

## 0.3.1

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.3.1

## 0.3.0

### Minor Changes

- new release

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.3.0

## 0.1.8

### Patch Changes

- use monorepo
- Updated dependencies
  - ethereum-indexer@0.0.15
