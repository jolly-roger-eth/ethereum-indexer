# ethereum-indexer-browser

## 0.8.0

### Minor Changes

- 8ed9af3: Add a `dispose()` method to the object returned by `createIndexerState`. It stops the auto-index loop and clears any armed timer (previously the self-re-arming `setTimeout(_auto_index, ...)` would keep firing forever if the consumer dropped its references without calling `stopAutoIndexing()`), detaches the `onLoad`/`onLastSyncUpdated`/`onStateUpdated` callbacks (which closed over the stores), drops the underlying `EthereumIndexer` reference, and resets the syncing/status state. It is idempotent. After `dispose()`, `init(...)` may be called again to re-initialise — note this reuses the same stores and processor instance rather than performing a full fresh start.
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

- d45f11d: The browser backend, behind the same seam: `@etherfold/state-store-indexeddb`, and it is the browser DEFAULT.

  **A new package.** Versioned rows in IndexedDB, so a tab keeps history, reverts a reorg, starts cold by reading one row instead of all of them, and pays a write cost proportional to what CHANGED. The same processor that runs on a server against `@etherfold/state-store-sqlite` runs on it unchanged, and `@etherfold/browser` gains the one line where a browser deployment chooses:

  ```ts
  const store = await createBrowserStateStore(processor.entities); // IndexedDB, the default
  const light = await createBrowserStateStore(processor.entities, {
  	backend: (entities) => new PatchStateStore(entities, {retention: 'revert-only', finalityDepth: 64}),
  });
  ```

  Choosing the second one touches no processor code: a processor is entity declarations plus `on<EventName>` handlers over a `MutationContext`, and it names no backend.

  **The default is a CONDITION, not a preference, and it is written down as one** (`docs/adr/0024`). On the real workload (the launched stratagems game on Base: 31,332 events, 4,072 live rows) IndexedDB beat wasm SQLite on writes by 1.6x to 6.9x and on reads by 4x to 14x on every engine that can run both, WebKit cannot run the SQLite route at all, and three of four tabs FAIL AT OPEN on both SQLite VFSs. The ADR records the four things that would all have to be true for wasm SQLite to win, and the five that would overturn the choice, from `work/notes/findings/sqlite-in-the-browser.md`.

  **It is not a speed-up.** The incumbent whole-state blob (`keepStateOnIndexedDB`) is the FASTEST writer at today's sizes: 2.0 ms/block on Chromium against 45.6 for row-level writes, a 20x throughput loss at 4,072 live rows. What row-level writes buy is what the blob cannot do at any speed: an as-of read, a revert, a bounded cold start, and a per-write cost that stops tracking total state.
  - **It passes `@etherfold/state-store-conformance`** under all three retention claims, in node under `fake-indexeddb` on every commit and in **Chromium, Firefox and WebKit** via `pnpm --filter @etherfold/state-store-indexeddb test:browser` (the same suite, not a browser-flavoured copy). Evidence in `docs/spikes/indexeddb-row-backend-browser-default/results/`.
  - **The bounded id-prefix listing is one `IDBKeyRange.bound([entity, ...prefix], [entity, ...prefix, []])` cursor**, asserted rather than assumed: the tests record the range the store handed IndexedDB and how many records it walked, because a scan-and-filter returns the same rows.
  - **Retention is enforced on both halves**, so what it reports is what it does: an as-of read outside the window throws `BlockNotRetainedError` and never the tip value, and `prune` walks the `upper` index — where a LIVE version cannot appear at all, because `null` is not a valid IndexedDB key — so the row that IS the current state cannot be dropped however old it is. The window is measured against the tip read from the database, so it is right after a reload and right when another tab moved it.
  - **`revertTo` is two index range scans** (drop what the fork opened, reopen what it closed) rather than a per-block undo journal, and `getAsOf` is one backwards cursor over that key's versions.
  - **Four tabs against one database complete with zero row mismatches**, which is the case both wasm-SQLite VFSs fail at open.

- 4097ccd: Rename misspelled public types `StreamFecther` → `StreamFetcher` and `ExistingStateFecther` → `ExistingStateFetcher`.

  This is a breaking change for any code importing these types by name (no deprecated aliases are kept). Update your imports accordingly.

- e0e5832: Renamed to the `@etherfold` scope (ADR-0017). `ethereum-indexer` is now `@etherfold/core`, and `ethereum-indexer-browser`, `-js-processor`, `-fs`, `-fs-cache` and `-utils` are now `@etherfold/browser`, `@etherfold/js-processor`, `@etherfold/fs`, `@etherfold/fs-cache` and `@etherfold/utils`. The two previously unpublished `@ethereum-indexer/*` packages move to `@etherfold/*`.

  The CLI is the one exception to the scope: `ethereum-indexer-cli` becomes the flat package **`etherfold`**, because it is the package that installs the `etherfold` command.

  No API changed: update the package name in your imports and the exports are identical.

  **You must migrate to keep receiving updates.** There is no re-export shim under the old names, so nothing further will be published as `ethereum-indexer*` and no version of an old name forwards to the new one. Already-published versions stay installable indefinitely, so existing pins keep resolving, but they are frozen.

  **The CLI command is renamed**: the CLI installs `etherfold` instead of `ei`, so `npm i -g etherfold` then `etherfold -p <processor>`. Update any script that shells out to `ei`.

  `named-logs` namespaces follow the package names, so any log filter matching `ethereum-indexer*` needs updating to `@etherfold/*`. The CLI is the exception: its namespaces follow the command, so `ei` and `ei:keepState` become `etherfold` and `etherfold:keepState`.

  `ethereum-indexer-server` and `ethereum-indexer-db-utils` are deliberately NOT renamed: both are on the retirement path set by ADR-0010, and they have since moved to `archive/` in the repository, outside the workspace. Their published versions stay installable and are not deprecated here.

- 0ac08c0: **One BigInt convention, and it identifies a BigInt instead of guessing at one.** Every storage adapter now tags: `{"__bigint__": "123"}`, the codec the wire and the sync cursor already used. **`bnReplacer`, `bnReviver` and `isBigIntLiteral` are removed from `@etherfold/core`**, and `bnReviver` is removed from `@etherfold/browser`.

  `"123n"` was both what `123n` serializes to and a perfectly legal string for a contract to emit, so the decoder could not tell them apart and silently changed the type of whichever it got wrong. That is silent in both directions: a real BigInt read back as a string breaks arithmetic downstream, a string read back as a BigInt breaks comparisons (including `===` against a hash) and JSON round-trips. It is not hypothetical, and both kinds genuinely coexist in one payload: `LastSync.unconfirmedBlocks` carries decoded `LogEvent`s whose `args` hold a BigInt per `uint256`, and the same document carries the `context` digests. `535ccc1` stopped that decoder THROWING on values that were never numbers and gave `simple_hash` a leading `h`; both were containment, and the guess itself is what this removes.

  Moved onto the tag: **`etherfold`**'s snapshot keeper, **`@etherfold/browser`**'s `keepStateOnIndexedDB` and `keepStateOnLocalStorage`, **`@etherfold/fs`**'s file keeper, and `@etherfold/core`'s captured stream fixture. `@etherfold/processor-entities` was already on it.

  **The legacy suffix form is not read, anywhere, and there is no fallback.** Translating it would be the same guess under a new name, and refusing every string of digits ending in `n` would refuse legitimate event data, so a `"123n"` string is now simply a string. Where a persisted artifact carries a FORMAT number the number was bumped instead, so a file written under the old convention is refused AS A FILE rather than half-decoded:
  - **`STREAM_FIXTURE_FORMAT` is 2.** `parseStreamFixture` refuses a format-1 fixture, naming the file.
  - **`etherfold`'s `SNAPSHOT_FORMAT` is 2, and older snapshots are no longer read.** A snapshot at format 1, or in the bare pre-envelope form, is logged and treated as absent, which cold starts. That is deliberate: its BigInts cannot be recovered by this reader, so resuming from it would resume from state whose every `uint256` had become a string, and re-indexing is the existing recovery for a snapshot that cannot be read. Delete the snapshot folder, or re-index once.
  - The two artifacts with no format number of their own -- `@etherfold/fs`'s keeper blob and `keepStateOnLocalStorage`'s -- are caches whose recovery is a re-index, so a stale one reads back with its BigInts as the `"123n"` strings they now are. Call `clear()`, or clear site data.

  `keepStateOnIndexedDB` needed the codec only on its REMOTE reads: the local half hands the object to `idb-keyval`, and IndexedDB's structured clone stores a BigInt as a BigInt.

  The `"123n"` rendering survives in exactly one place, `simple_hash`, which uses it to have bytes to hash. Nothing decodes those bytes, so there is no guess to make, and changing it would change every digest ever persisted.

- cefe0de: Answer "does the indexed state already account for this transaction?", so an app can lay an optimistic update over indexed state without counting it twice.

  `checkTxInclusion(lastSync, queries, finality)` (`@etherfold/core`) returns one verdict per transaction hash: `included`, `absent` or `unknown`, with the basis it was concluded on. `createIndexerState(...).checkTxInclusion(queries)` (`@etherfold/browser`) is the same thing against the cursor the hook is holding and the finality depth the indexer actually runs with, which is also newly exposed as `EthereumIndexer.finalityDepth`.

  Nothing is stored for this and no processor declares anything for it: the answer comes out of `LastSync.unconfirmedBlocks`, which already holds the reorg-eligible window as whole blocks with their events, and every event carries its `transactionHash`. The set maintains itself under reorg, since a reorged-out block leaves the window and a re-included transaction re-enters it.

  The comparison is deliberately NOT against the caller's own receipt. A block height is a local opinion about a chain rather than an identity, and the receipt's block hash is the wrong identity: after a reorg the same transaction can be re-included in a different block, so comparing hashes reports "not indexed" for a transaction that is indexed, which is exactly the double-count. A window hit must also be behind `lastToBlock`, because `feed` publishes the whole new window before it walks the cursor through it.

  Two limits are documented on the function: only transactions that emitted events this indexer indexes can hit (the window is sparse), and `absent` means "not in the window", so a caller must not ask about a transaction older than it, which a transaction the app itself just submitted cannot be.

### Patch Changes

- 535ccc1: Stop the `"123n"` BigInt convention from mangling the hashes stored beside it.

  Six copies of the same reviver decided a string was a BigInt by testing its FIRST and LAST character, then called `BigInt()` on everything in between:

  ```ts
  (v.startsWith('-') ? !isNaN(parseInt(v.charAt(1))) : !isNaN(parseInt(v.charAt(0)))) && v.charAt(v.length - 1) === 'n';
  ```

  That admits `1x9tbhn`, which is not a BigInt literal but an ordinary base36 `simple_hash` digest, and `context.processor`, `context.config` and `context.source[].hash` are all made of those. `BigInt('1x9tbh')` throws, from inside `JSON.parse`. In the CLI, whose `keepState.fetch` catches parse failures, that meant a perfectly good snapshot being read as corrupt and the whole state re-indexed from scratch, permanently, for roughly 1.25% of config hashes, with a log line blaming the file. The copies without a `try/catch` simply threw.
  - The predicate now lives once, in `@etherfold/core` as `isBigIntLiteral` (with `bnReplacer` / `bnReviver` beside it), and every live copy uses it: the CLI, both browser adapters (including `keepStateOnIndexedDB`, the in-browser path ADR-0002 calls primary) and the fs adapter. A dead copy in `@etherfold/js-processor`'s `history.ts` was deleted.
  - **`simple_hash` now prefixes every digest with `h`, so all hashes change.** A guard cannot rescue a digest of all digits ending in `n` (`8918n`), because that genuinely IS the convention's shape: such a digest came back from storage as a BigInt, and `processorHash === context.processor` then compared a string to a BigInt and discarded state that was fine. The prefix makes the shape unreachable instead of unlikely.
  - **`simple_hash` no longer drops falsy values.** It filtered with a bare `if (value)`, so `{fee: 0}` hashed identically to `{}` and `{enabled: false}` identically to `{}`: a config change to a falsy value could not invalidate the state computed under the old one. `undefined` is still dropped, matching `JSON.stringify`, so a value hashed before and after a round trip still agree.
  - `simple_hash` also accepts BigInt values instead of throwing on them, which a processor config holding a `uint256` would previously have done.

  The suffix convention itself is still a guess: it cannot distinguish a real BigInt from a contract-emitted string that reads like one. `@etherfold/processor-sqlite`'s tagged `{__bigint__: "..."}` codec is the form that can, and is where the remaining adapters should go.

- 4e75014: **An entity store can start from state somebody else computed, and it stays honest about the history it never received** (ADR-0028).

  This is the entity path's half of a capability the free-form path has always had: `keepStateOnIndexedDB(name, remote)` takes one or more published locations, asks each how far it has got, uses the furthest, prefers LOCAL state when local is already ahead, and skips an unreachable mirror rather than dying. A client that bootstraps comes up near the tip instead of replaying every log the contract ever emitted.

  **`@etherfold/state-store`** gains the snapshot envelope and the store handle that keeps it honest:
  - `StateSnapshot` -- `{format, processor, savedAt, takenAt, cursor, rows}`, deliberately shaped like the CLI's file envelope so a reader of one recognises the other. `rows` are the LIVE rows at `takenAt`, and `SnapshotHead` is the same envelope without them, which is what a client fetches to choose between mirrors.
  - `openSnapshotAware(store)` -- the handle a deployment that may bootstrap uses on EVERY boot (it migrates the store itself). `.bootstrap(snapshot, {processor})` installs the rows and their cursor as one `applyBlock`, and records where the contents came from under a second cursor-port key (`SNAPSHOT_ORIGIN_KEY`), so a reload is as honest as the first run.
  - The honesty: a bootstrapped store reports its retention as a **window whose oldest block is the snapshot's**, never the `unbounded` a freshly migrated store would claim, and an as-of read below that block is refused with `BlockNotRetainedError` instead of answering `undefined` -- which would read as "the entity was absent then", an ordinary answer a caller acts on normally, and wrong. The floor is intersected with whatever the deployment configured, and a store that answers no historical read at all is left saying exactly that.
  - `RevertBeyondSnapshotError` -- a reorg reaching below the snapshot is refused loudly and changes nothing. There are no superseded versions under the snapshot to reopen at any price, and a partly undone reorg is a plausible state nothing downstream can tell apart from a correct one.
  - `SnapshotProcessorMismatchError` / `SnapshotFormatError` -- a snapshot computed by another processor version, or in an envelope this build does not read, is refused rather than loaded.

  **`@etherfold/processor-entities`** gains the client side:
  - `bootstrapFromSnapshot(store, locations, {processor, finalityDepth?, fetch?})` -- mirrors, most-advanced-wins, prefer-local, fail over on error. Two deliberate differences from the free-form keeper: failover walks EVERY remaining candidate in descending order (the keeper tries the winner and one more), and a snapshot from another processor version is not a candidate at all. Given a `finalityDepth`, a snapshot taken inside the reorg-eligible window of the tip its producer had observed is declined, so the revert that could not be undone is avoided as well as refused. It returns a `BootstrapOutcome` rather than throwing when nothing is usable: indexing from the start block is the correct answer to "no snapshot is available".
  - `openAndBootstrap(store, locations, options)` -- the boot path, which keeps the SAFE order the short one: open snapshot-aware first, then bootstrap only if the store has never synced.
  - `createSnapshot(...)` -- the MINIMAL producer, and it says so. Publishing snapshots as a first-class artifact (a publish command, format versioning, mirror layout, pruning old ones) is a design of its own.

  **`@etherfold/browser`** gains no API and one piece of documentation that matters: `createBrowserStateStore` now says how a browser deployment bootstraps, and that the store must be opened through `openSnapshotAware` on EVERY boot rather than only on the boot that installs a snapshot. The mechanism deliberately does not live here -- deciding whether local is already ahead means reading `lastToBlock` out of a stored cursor, and the cursor's codec belongs to the entity runtime (ADR-0027), which this package does not depend on so that it stays free of any one processor package.

  **`@etherfold/state-store-conformance`** gains a `bootstrapping from a snapshot` group, so every backend inherits the obligation rather than rediscovering the trap in somebody's browser tab: rows and cursor installing as one unit, the origin surviving a fresh handle over the same storage, the revert refusal, the wipe still working, and -- selected on what the backend claims -- the floor being refused below and answered at and above.

- a19abb9: Add an optional `createIndexer` factory to `createIndexerState` options. When provided it is used to construct the underlying `EthereumIndexer`, receiving the same arguments (request-tracked/logged provider, configured processor, source, config) that the default `new EthereumIndexer(...)` would. Useful for injecting a subclass, a shared instance, or a spy/fake (e.g. in tests). Defaults to the existing behaviour when omitted.
- a4d840a: `updateProcessor` now accepts an optional `{force?: boolean}` argument that is forwarded to the core `EthereumIndexer.updateProcessor`, allowing a processor swap (clear + reload) even when the new processor has the same version hash as the current one.
- 01b2a0c: Clear stale `$syncing.lastSync` after a successful `updateIndexer` / `updateProcessor`. Previously `setupIndexing()` would early-return on the leftover `lastSync` from the old configuration, so after a live reload (new contracts / event ABIs / processor) progress was computed against the old start block and setup did not re-run. State is only cleared on success — a failed reconfigure keeps the previous valid progress and surfaces `$syncing.error`. Status is left untouched and corrects itself on the next indexing operation.
- 30ca765: Pause auto-indexing during `updateIndexer` / `updateProcessor` and resume it afterwards. Previously the auto-index timer kept firing while the core was mid-reinit, so a tick could call `indexMore` against a blocked/half-reconfigured indexer (throwing `Blocked` → retry → re-arm, racing the reconfigure). Now the loop is stopped before the awaited core call and resumed (even if the reconfigure fails) once it settles. On success, stale syncing state is cleared before the loop resumes so it does not early-return on the old `lastSync`.
- 7b01126: Serialize reconfiguration so overlapping `updateIndexer` / `updateProcessor` calls no longer interleave. Source changes (new contracts / event ABIs) and processor changes (new handler logic) are independent events that can arrive close together and in either order (e.g. a slow deploy's source change racing a processor edit). Previously each call ran its own reset/reinit/load asynchronously, so two overlapping calls could interleave on the same indexer instance. They now run through an internal queue — each reconfigure runs only after the previous one has fully settled (success or failure), preserving arrival order — while remaining independently usable. The pause/resume of auto-indexing and the clear-on-success of stale syncing state happen inside the serialized section.
- 149fdc3: Fix `setupIndexing` reporting a `FAILED_TO_LOAD` error on every call. The error was set in a `finally` block, so it ran even when loading succeeded. Use a `catch` (re-throwing the error) so the error flag is only set on an actual failure.
- 9b062f4: Make the browser `updateIndexer` / `updateProcessor` `async` and await the underlying core call, returning a promise callers can await before re-indexing. Errors from the core reconfiguration are now routed into `$syncing.error` (`FAILED_TO_UPDATE_INDEXER` / `FAILED_TO_UPDATE_PROCESSOR`) and re-thrown, instead of surfacing as an unhandled promise rejection.
- bc118e4: Declare the packages the published types import, so installing them actually typechecks.

  A type-only import is erased from the emitted `.js` but survives in the emitted `.d.ts`. These packages name types from `abitype`, `eip-1193` and `@etherfold/core` in their public declarations while listing those as `devDependencies`, so a consumer installing them got declaration files importing packages that were never installed.

  Moved to `dependencies`: `abitype` and `eip-1193` in `@etherfold/core`, `eip-1193` in `@etherfold/browser`, and `@etherfold/core` in `@etherfold/utils`.

  Measured against a packed tarball installed under pnpm's isolated linker with `hoist=false`, `tsc --strict --skipLibCheck false` reported 11 errors (6 for `abitype`, 5 for `eip-1193`) before and none after.

  The bug was hard to see from inside the workspace, which is why it lasted. pnpm keeps a hoisted fallback directory holding every transitive package, so an undeclared import still resolves as long as anything else in the tree depends on it: `abitype` was masked that way by viem and failed only with hoisting off, while `eip-1193`, which nothing else depends on, failed everywhere. `skipLibCheck: true`, which most consumers set, suppresses the diagnostics entirely and silently degrades the affected types instead.

  A test now asserts, for every package in the workspace, that each bare specifier in its built `.d.ts` files is a declared dependency. It found the `@etherfold/utils` case, which a search for the two known package names had missed.

- Updated dependencies [ff393f7]
- Updated dependencies [6c875dd]
- Updated dependencies [535ccc1]
- Updated dependencies [4e75014]
- Updated dependencies [ce8f7d2]
- Updated dependencies [aeb7843]
- Updated dependencies [0957f8c]
- Updated dependencies [c681b79]
- Updated dependencies [9d21d67]
- Updated dependencies [ca6f981]
- Updated dependencies [b61de79]
- Updated dependencies [31833b6]
- Updated dependencies [2a4e6ed]
- Updated dependencies [047cd73]
- Updated dependencies [eba61c3]
- Updated dependencies [dece521]
- Updated dependencies [939364a]
- Updated dependencies [d24872f]
- Updated dependencies [78d8377]
- Updated dependencies [3de4c35]
- Updated dependencies [bc118e4]
- Updated dependencies [bc5d71a]
- Updated dependencies [d45f11d]
- Updated dependencies [e0a6480]
- Updated dependencies [9738f1c]
- Updated dependencies [879c4fe]
- Updated dependencies [33afc5b]
- Updated dependencies [01ab642]
- Updated dependencies [18c6876]
- Updated dependencies [4097ccd]
- Updated dependencies [e0e5832]
- Updated dependencies [ab45129]
- Updated dependencies [ebf9690]
- Updated dependencies [5854d60]
- Updated dependencies [3a78285]
- Updated dependencies [0ac08c0]
- Updated dependencies [cefe0de]
- Updated dependencies [47252ad]
  - @etherfold/state-store@0.1.0
  - @etherfold/core@0.7.0
  - @etherfold/utils@0.7.0
  - @etherfold/state-store-indexeddb@0.1.0

## 0.7.7

### Patch Changes

- prevent re-initialization

## 0.7.6

### Patch Changes

- use source hash in generated file names for indexed state
- Updated dependencies
  - ethereum-indexer-utils@0.6.13

## 0.7.5

### Patch Changes

- parseJson if lastSync via bnReviver too

## 0.7.4

### Patch Changes

- fix: bnReviver for all remote fetch

## 0.7.3

### Patch Changes

- bnRevivier for snapshots

## 0.7.2

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.21
  - ethereum-indexer-utils@0.6.12

## 0.7.1

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.20
  - ethereum-indexer-utils@0.6.12

## 0.7.0

### Minor Changes

- support url

## 0.6.30

### Patch Changes

- support folder export with lastSync + allow fetch lastSync first to get latest sync
- Updated dependencies
  - ethereum-indexer-utils@0.6.12

## 0.6.29

### Patch Changes

- new loading state + CatchingUp for browser-indexer
- Updated dependencies
  - ethereum-indexer@0.6.19

## 0.6.28

### Patch Changes

- allow to reset indexer
- Updated dependencies
  - ethereum-indexer@0.6.18

## 0.6.27

### Patch Changes

- revert freeze logs

## 0.6.26

### Patch Changes

- tmp: copy before store

## 0.6.25

### Patch Changes

- tmp: forgot to build

## 0.6.24

### Patch Changes

- tmp: more logs

## 0.6.23

### Patch Changes

- tmp more logs

## 0.6.22

### Patch Changes

- tmp : forzen in browser state handler

## 0.6.21

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.17

## 0.6.20

### Patch Changes

- show response/error when logRequests == true

## 0.6.19

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.16

## 0.6.18

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.15

## 0.6.17

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.14

## 0.6.16

### Patch Changes

- option to log all requests

## 0.6.15

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.13

## 0.6.14

### Patch Changes

- latest deps
- Updated dependencies
  - ethereum-indexer@0.6.12

## 0.6.13

### Patch Changes

- allow reading from file for deployments

## 0.6.12

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.11

## 0.6.11

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.10

## 0.6.10

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.9

## 0.6.9

### Patch Changes

- reorg + add streams server (wip)
- Updated dependencies
  - ethereum-indexer@0.6.8

## 0.6.8

### Patch Changes

- improve processor import to work in pnpm + startBlock fix
- Updated dependencies
  - ethereum-indexer@0.6.7

## 0.6.7

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.6

## 0.6.6

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.5

## 0.6.5

### Patch Changes

- fix state direct access

## 0.6.4

### Patch Changes

- c81fb4d: use state field name instead of data
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

- cleanup exports
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

- reorg
- Updated dependencies
  - ethereum-indexer@0.4.2

## 0.4.1

### Patch Changes

- allow access to state from processors that declare it
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

- typings
- Updated dependencies
  - ethereum-indexer@0.3.8

## 0.3.8

### Patch Changes

- types
- Updated dependencies
  - ethereum-indexer@0.3.7

## 0.3.7

### Patch Changes

- browser indexer can be initialised any time

## 0.3.6

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.3.6

## 0.3.5

### Patch Changes

- use eip-1193 types
- Updated dependencies
  - ethereum-indexer@0.3.5

## 0.3.4

### Patch Changes

- force new version
- Updated dependencies
  - ethereum-indexer@0.3.4

## 0.3.3

### Patch Changes

- republish with new types
- Updated dependencies
  - ethereum-indexer@0.3.3
