# ethereum-indexer-browser

## 0.8.0

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

- 3a78285: Capture an event stream once, replay it forever, with no node in the loop.

  Indexing was reproducible only in the sense that the chain does not change: every run re-fetched, so two runs saw different bytes whenever a node paginated differently, rate-limited, or simply moved on. That makes a benchmark unfair between candidates, a processor test slow and flaky, and "the same input" impossible to say out loud.
  - **`captureStream(provider, source, {toBlock, ...})`** fetches a range once through the same `LogEventFetcher` the live path uses, and returns a `StreamFixture`: format version, provenance (`capturedAt`, chain, block range, plus whatever the caller adds (contracts commit, node, run)), the `IndexingSource` it was captured for, the cursor, and the decoded events. `toBlock` must be a number, never `'latest'`: a snapshot whose upper bound was "whenever it ran" cannot be re-captured and compared against itself.
  - **`serializeStreamFixture` / `parseStreamFixture`** move it as text, with BigInt event arguments surviving via the `"123n"` convention already used by every storage adapter here. Parsing refuses an unknown format or a missing field up front, where the message can still name the fixture.
  - **`replayStream(fixture)`** is an `ExistingStream` over a fixture, so the seam the indexer already consults before fetching can be pointed at a file. It never writes: a replay that appended to its own input would stop being a replay of the thing whose provenance is recorded at the top of it.
  - **`replayFixtureInto(processor, fixture, streamConfig)`** drives a processor over the fixture with no provider at all, **one block per `process` call**, because that is how blocks arrive and how they are applied. `chainTip: 'live' | 'final'` chooses whether each block is presented as the tip (keeping the processor's reorg-eligible path, and so its history, doing what it did live) or as already final.
  - **`blocksOf(fixture)`** groups a fixture into the blocks it contains, in order, for callers that want to drive the batching themselves.
  - **`@etherfold/fs`** gains `saveStreamFixture` / `loadStreamFixture`, indented by default because a fixture is a committed artifact that gets read and diffed, and **gzipped when the path ends in `.gz`**. That last part is not a convenience: a real capture is 20.5 MB of JSON and 0.6 MB gzipped, git stores both at about 0.6 MB, so the compressed form costs nothing in the repository and saves 20 MB in every working tree.

  Additive: nothing existing changes behaviour.

- 0ac08c0: **One BigInt convention, and it identifies a BigInt instead of guessing at one.** Every storage adapter now tags: `{"__bigint__": "123"}`, the codec the wire and the sync cursor already used. **`bnReplacer`, `bnReviver` and `isBigIntLiteral` are removed from `@etherfold/core`**, and `bnReviver` is removed from `@etherfold/browser`.

  `"123n"` was both what `123n` serializes to and a perfectly legal string for a contract to emit, so the decoder could not tell them apart and silently changed the type of whichever it got wrong. That is silent in both directions: a real BigInt read back as a string breaks arithmetic downstream, a string read back as a BigInt breaks comparisons (including `===` against a hash) and JSON round-trips. It is not hypothetical, and both kinds genuinely coexist in one payload: `LastSync.unconfirmedBlocks` carries decoded `LogEvent`s whose `args` hold a BigInt per `uint256`, and the same document carries the `context` digests. `535ccc1` stopped that decoder THROWING on values that were never numbers and gave `simple_hash` a leading `h`; both were containment, and the guess itself is what this removes.

  Moved onto the tag: **`etherfold`**'s snapshot keeper, **`@etherfold/browser`**'s `keepStateOnIndexedDB` and `keepStateOnLocalStorage`, **`@etherfold/fs`**'s file keeper, and `@etherfold/core`'s captured stream fixture. `@etherfold/processor-entities` was already on it.

  **The legacy suffix form is not read, anywhere, and there is no fallback.** Translating it would be the same guess under a new name, and refusing every string of digits ending in `n` would refuse legitimate event data, so a `"123n"` string is now simply a string. Where a persisted artifact carries a FORMAT number the number was bumped instead, so a file written under the old convention is refused AS A FILE rather than half-decoded:
  - **`STREAM_FIXTURE_FORMAT` is 2.** `parseStreamFixture` refuses a format-1 fixture, naming the file.
  - **`etherfold`'s `SNAPSHOT_FORMAT` is 2, and older snapshots are no longer read.** A snapshot at format 1, or in the bare pre-envelope form, is logged and treated as absent, which cold starts. That is deliberate: its BigInts cannot be recovered by this reader, so resuming from it would resume from state whose every `uint256` had become a string, and re-indexing is the existing recovery for a snapshot that cannot be read. Delete the snapshot folder, or re-index once.
  - The two artifacts with no format number of their own -- `@etherfold/fs`'s keeper blob and `keepStateOnLocalStorage`'s -- are caches whose recovery is a re-index, so a stale one reads back with its BigInts as the `"123n"` strings they now are. Call `clear()`, or clear site data.

  `keepStateOnIndexedDB` needed the codec only on its REMOTE reads: the local half hands the object to `idb-keyval`, and IndexedDB's structured clone stores a BigInt as a BigInt.

  The `"123n"` rendering survives in exactly one place, `simple_hash`, which uses it to have bytes to hash. Nothing decodes those bytes, so there is no guess to make, and changing it would change every digest ever persisted.

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

- Updated dependencies [6c875dd]
- Updated dependencies [535ccc1]
- Updated dependencies [aeb7843]
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
- Updated dependencies [47252ad]
  - @etherfold/core@0.7.0
  - @etherfold/utils@0.7.0

## 0.7.7

### Patch Changes

- Updated dependencies
  - ethereum-indexer-utils@0.6.13

## 0.7.6

### Patch Changes

- add ethereum-indexer-fs

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
