# ethereum-indexer-utils

## 0.7.0

### Minor Changes

- aeb7843: **`createIndexerState` takes an entity processor, so a tab can index into the store the application chose.**

  The two halves existed and nothing joined them: `createBrowserStateStore` built a browser `StateStore` and was referenced by nothing except its own test, while the hook's processor type was `EventProcessorWithInitialState` — the free-form-object interface — so an entity processor could not be handed to it at all.

  ```ts
  const store = await createBrowserStateStore(myProcessor.entities); // one line picks the backend
  const indexer = createIndexerState({kind: 'entities', processor: fromEntityProcessor(myProcessor)(store)});
  ```

  **Both kinds are accepted and the caller SAYS which**, in a tag the compiler checks (`ProcessorKind` = `'js-object' | 'entities'`, `TaggedProcessor`, `IndexerStateProcessor`). A bare `EventProcessorWithInitialState` still means `'js-object'` and every existing call site keeps working untouched; passing the wrong processor under a tag is a compile error rather than a missing method three calls later. The discrimination is deliberately never a sniff for `createInitialState`, which a wrapper, a proxy or a decorator can make wrong in silence.
  - The free-form path CREATES its initial state; the entity path READS its store through the handle the processor already exposes (`processor.state`), because there is nothing to seed — the state is in the store.
  - **`keepState` on the entity path is refused**, with a message naming the store: an entity deployment persists through its `StateStore`, cursor included (ADR-0027), so a keeper there is a second place to persist rather than a second opinion. `keepState` stays optional and unchanged for the free-form path.
  - `updateProcessor` takes either kind, tagged the same way.
  - `options.createIndexer` now receives the processor as `EventProcessor<ABI, ProcessResultType>` — what `new EthereumIndexer(...)` takes, and the one thing both kinds have in common. A caller that annotated that parameter as `EventProcessorWithInitialState` has to widen it.

  **Reload continuity is the browser-specific risk and it is now tested on a real engine.** `pnpm --filter @etherfold/browser test:browser` runs the hook through a captured stream in Chromium, Firefox and WebKit, including a REAL page reload: a tab that indexed, closed and reopened resumes from its cursor rather than re-indexing from the start block. On `@etherfold/state-store-patch` a reload legitimately starts over (memory-only, ADR-0023), and the store says so in `capabilities.durability` before it happens.

  **`@etherfold/browser` bundles for a browser again, and `@etherfold/utils` gained a `./indexer` subpath to make that true.** The barrel re-exports the CLI-side modules, whose top-level `node:fs` / `node:path` / `node:module` imports made `import '@etherfold/browser'` unresolvable for esbuild and for vite, before tree-shaking could help. `storage/state/OnIndexedDB.ts` now imports `contextFilenames` from `@etherfold/utils/indexer` (platform-free by construction), and a test bundles the package with `platform: 'browser'` on every commit so it cannot come back. `@etherfold/utils`' existing barrel is unchanged.

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

- 47252ad: Add a shared `resolveProcessorAndSource` helper (plus the smaller `loadProcessorModule`, `instantiateProcessor` and `resolveSource` building blocks) that turns a processor module path + options into `{processor, processorModule, source}`. This extracts the near-identical processor/source setup that was previously copy-pasted between the CLI's `init()` and the server's `setupIndexing()` (LOW-4 in the server/CLI batch audit), removing the divergence risk between the two copies.

  Behaviour is the superset of the previous copies: module resolution keeps the server's `createRequire(...).resolve()` fallback for bare package specifiers (the CLI lacked it), and the processor-factory argument is now an explicit `processorConfig` parameter so the intentional CLI/server difference (CLI calls the factory with no args, the server passes its folder) is documented rather than accidental. The helpers are pure and unit-tested (module-resolution paths, the `contractsDataPerChain`/`contractsData` resolution, the provided-source path, and the no-factory / no-chainId / no-contracts error cases).

### Patch Changes

- bc118e4: Declare the packages the published types import, so installing them actually typechecks.

  A type-only import is erased from the emitted `.js` but survives in the emitted `.d.ts`. These packages name types from `abitype`, `eip-1193` and `@etherfold/core` in their public declarations while listing those as `devDependencies`, so a consumer installing them got declaration files importing packages that were never installed.

  Moved to `dependencies`: `abitype` and `eip-1193` in `@etherfold/core`, `eip-1193` in `@etherfold/browser`, and `@etherfold/core` in `@etherfold/utils`.

  Measured against a packed tarball installed under pnpm's isolated linker with `hoist=false`, `tsc --strict --skipLibCheck false` reported 11 errors (6 for `abitype`, 5 for `eip-1193`) before and none after.

  The bug was hard to see from inside the workspace, which is why it lasted. pnpm keeps a hoisted fallback directory holding every transitive package, so an undeclared import still resolves as long as anything else in the tree depends on it: `abitype` was masked that way by viem and failed only with hoisting off, while `eip-1193`, which nothing else depends on, failed everywhere. `skipLibCheck: true`, which most consumers set, suppresses the diagnostics entirely and silently degrades the affected types instead.

  A test now asserts, for every package in the workspace, that each bare specifier in its built `.d.ts` files is a declared dependency. It found the `@etherfold/utils` case, which a search for the two known package names had missed.

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

## 0.6.13

### Patch Changes

- use source hash in generated file names for indexed state

## 0.6.12

### Patch Changes

- support folder export with lastSync + allow fetch lastSync first to get latest sync

## 0.6.11

### Patch Changes

- let specify genesisHash as source param, useful for local chain

## 0.6.10

### Patch Changes

- latest deps

## 0.6.9

### Patch Changes

- allow reading from file for deployments

## 0.6.8

### Patch Changes

- reorg + add streams server (wip)
