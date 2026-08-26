# ethereum-indexer

## 0.7.0

### Minor Changes

- 6c875dd: The stateless log-fetcher, and the sending half of the wire contract (ADR-0003, ADR-0004).

  `@etherfold/core` gains **`LogFetcher`**: the chain-facing half of a split deployment, whose one operation is `fetchAndPush()` -- work out where to start, fetch a contiguous range of logs over EIP-1193, and push it. WHEN that runs is a host's business, so nothing in it schedules anything and it names no runtime (a test reads the sources and asserts that, along with the rest below).

  It holds **no cursor**. The receiver is authoritative, and a `409 {expectedFromBlock}` is not an error but the normal correction path: after a restart, after a lost acknowledgement, or when a second fetcher pushed in between, the fetcher is told where it really is and re-sends from there inside the same cycle. What it keeps between cycles is a HINT -- the last value the receiver reported -- which saves one round-trip, is dropped the moment a push fails, and is never persisted. Losing it costs one extra request and nothing else, which is the test for whether state is safe to hold on this side.

  It holds **no reorg logic** either. Nothing it sends carries a `removed` marker or an unconfirmed window; it re-delivers the window the receiver asks for and the receiver derives every retraction. The round-trip test drives a real fetcher against a real `StreamBuilder` over a real database through the real HTTP routes, and asserts that a reorg is concluded correctly from raw ranges alone -- and that the pair lands on the same state a single-process `EthereumIndexer` reaches from the same chain.

  **A partial range is never pushed**, which is the one thing this component must not get wrong: the receiver cannot tell a short payload from "no logs there", so it would read the gap as a reorg and delete state. A provider that ANNOUNCES a result cap makes `toBlock` shrink (the range fetcher already reports how far it really got). A provider that truncates SILENTLY -- exactly the cap back, no error -- is not believed: the range is halved until the answer is under the cap, and a single block that still lands exactly on it throws the new **`SuspectedTruncationError`** rather than delivering something that might be short.

  **Set `suspectResultCount` to your node's real `eth_getLogs` cap.** Silent truncation can only be detected by matching the cap EXACTLY -- a capped answer and a complete one differ in nothing else -- so the option defaults to 10000 (the most common cap) and a node that silently caps at some other number is not caught by the default. Do not try to reach the same effect by raising `fetch.maxEventsPerFetch`: that also widens the span each fetch asks for, which makes truncation more likely rather than less. The two knobs mean different things: one is what this fetcher asks for, the other is what the node will silently refuse to exceed.

  Also new: **`createHttpIngestion`**, the HTTP transport, which maps status codes onto the two refusal families a sender must tell apart -- `409` is the only resumable one, everything else in the 4xx family is an **`IngestionRefusedError`** that is surfaced immediately instead of retried forever, and a `5xx` or an unreachable server is an **`IngestionUnavailableError`** that is retried with bounded backoff. Batches are written with `serializeWireBatch`, so BigInt event arguments cross intact. The `INGEST_TOKEN` is sent as a bearer token and never appears in a message or a log line. **`UnexpectedChainError`** covers the check only this side can make: the receiver holds no provider, so a fetcher pointed at the wrong chain is the one corruption it could never catch.

  Internally, the timestamp/transaction enrichment moved out of `EthereumIndexer` into one shared implementation, so both deployment shapes honour `alwaysFetchTimestamps` / `alwaysFetchTransactions` identically, and the private `LogFetcher` class behind `eth_getLogs` is now `RangeLogFetcher`, since the public name belongs to the component ADR-0003 names.

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

- 0957f8c: Read `blockTimestamp` off the log, and only fetch the blocks that are missing one.

  `ethereum/execution-apis#639` (merged 2025-08-25) puts `blockTimestamp` on every log object, and geth (>= 1.16.0), reth, besu, erigon and anvil all serve it. The fetcher was dropping the field during decoding, so `alwaysFetchTimestamps` always paid for a second `eth_getBlockByHash` per block even when the timestamp had already arrived with the log.

  `NumberifiedLog` now carries an optional `blockTimestamp`, populated from the log when the node provides it (hex QUANTITY or decimal, per `parseLogBlockTimestamp`; anything unreadable is treated as absent rather than coerced to 0). `alwaysFetchTimestamps` becomes a fallback: the block-fetch list is built only from the blocks whose logs carried no timestamp, so it costs nothing on a compliant node and behaves exactly as before on one that is not. Hardhat's EDR does not emit the field as of hardhat 3.14.0, which is why the fallback stays.

  Verified end to end against a real anvil 1.5.1 (indexing three blocks of real events uses `eth_chainId`, `eth_blockNumber` and `eth_getLogs` only, with zero block fetches) and against a real Hardhat node (the fallback engages and timestamps are still correct). This matters most for the in-browser path ADR-0002 makes primary, where a provider frequently cannot batch those calls and each one is its own round-trip.

- 31833b6: `createDirectIngestion`: the ADR-0004 wire, with no wire.

  The split of ADR-0003 was always meant to be a DEPLOYMENT choice rather than two implementations, and this is the eighteen lines that make that literally true. Both sides of the contract are interfaces (`IngestionTarget` for the sender, `LogIngestion` for the receiver), so `createDirectIngestion(streamBuilder)` hands a `LogFetcher` straight to a `StreamBuilder` in the same process, and one deployable fetches and processes while running exactly the code a split deployment runs.

  What survives is nearly all of it, because none of it came from HTTP: the receiver is still authoritative about the cursor, still derives every reorg, and still refuses a batch that does not start where it says; the fetcher still holds no cursor, still asks before its first fetch, and is still corrected rather than crashed when it asks from the wrong place. What is lost is what the transport was carrying: a network hop, a shared secret, and the two failure modes that go with them.

  **The one thing it must get right is that a cursor refusal is a correction and not a fault.** Over HTTP that is the `409`; here it is a thrown `UnexpectedFromBlockError`, and a sender that received it as an exception would treat the ordinary case (a restart, a lost acknowledgement, a second fetcher) as a crash. It is recognised STRUCTURALLY rather than with `instanceof`, for the same reason `retryable` is read structurally: two copies of this package in one dependency tree would otherwise turn the resumable refusal into a fault, and only in the deployments that bundle awkwardly. Every other refusal passes through untouched, `retryable` flag included, since there is no status code here to flatten it into.

  Which deployment this is for: one that can hold a PROCESS, since that is what driving the chain needs. A serverless runtime is a good home for the receiving half and a poor one for the fetching half, so the two shapes worth having are a Node process that pushes over HTTP to an indexer-server anywhere (a Worker among them), and a Node process that runs both halves with this in the middle.

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

- e0a6480: The log ingestion endpoint, and the receiving half of the wire contract (ADR-0004).

  `@etherfold/core` gains **`StreamBuilder`**: the stream-builder of ADR-0003, as an object. It takes contiguous ranges of raw logs from a stateless log-fetcher, derives every retraction itself, drives an `EventProcessor`, and is authoritative about where the next range must start. It makes no chain calls at all, which is why it is not `EthereumIndexer`: that class opens `load()` with `eth_chainId`, so the half of a split deployment that hosts the processor could never use it. It reads the persisted cursor on every call rather than caching one, because the intended host is serverless and an in-memory cursor is one isolate's private opinion of a value the database owns.

  `@etherfold/server` gains **`GET` and `POST /ingest`**, behind an `INGEST_TOKEN` bearer token. The stream-builder is injected exactly like the database (`getIngestion` alongside `getDB` / `getEnv`), so which processor runs against which source stays a deployment's choice; a server with none answers `501` rather than pretending to have a cursor.

  The cursor is the idempotency key, so there is no dedupe table and no idempotency header. A batch whose `fromBlock` is not the server's `expectedFromBlock` is refused with **`409` carrying that value**, and the sender re-sends from there; a batch re-sent after a lost acknowledgement takes exactly that path, so at-least-once on the wire is exactly-once in effect. `409` is the only resumable refusal: a foreign `{source, config}`, a malformed range, or a payload that is not the range it claims are `400`, because no block number makes them right and a sender must not retry them forever.

  `generateStreamToAppend` now throws a typed `UnexpectedFromBlockError` carrying `expectedFromBlock`, instead of an `Error` whose message had to be parsed. Same rule, same message, one place: the HTTP layer reads the number off the error rather than re-deriving it, so the wire and the engine cannot drift apart.

  A revert concluded from **absence** is surfaced and counted apart from one concluded from a hash **contradiction**. Absence is an inference and is indistinguishable from a sender that under-delivered a range, so `/status` now reports `reorgs: {absence, contradiction, last}` from the database (not from process memory, since a rate is the point and isolates are recycled), and an absence-driven revert is logged at `error` level naming the range. It does not make the server unhealthy: it is a signal to investigate, not a fault.

  Wire batches are serialized with `serializeWireBatch` / `parseWireBatch`, which tag BigInts as `{__bigint__: "..."}`. A decoded log's `args` hold a BigInt for every `uint256` an ABI declares and `JSON.stringify` throws on those, while the older `"123n"` suffix convention would revive a contract-emitted string ending in `n` as a number. The tagged codec now lives once, in `@etherfold/core` (`taggedBnReplacer` / `taggedBnReviver`), and `@etherfold/processor-entities`' sync-cursor codec uses it instead of its own copy.

- 9738f1c: One processor, run under the single-process CLI and under the split indexer-server, is now a test rather than an assurance.

  `packages/processor-sqlite/test/deployment-shapes.test.ts` takes ONE `EntityProcessor` (one `version`, one set of entity declarations, imported and not rewritten) and runs it two ways over the same captured chain: as a single `EthereumIndexer` doing fetch, stream-building and processing in one process (what `etherfold serve` is, and the intended CLI shape), and as a split deployment where a stateless log-fetcher pushes contiguous ranges across a wire to an indexer-server that hosts the stream-builder and the processor. Both land on the same state, including through a reorg whose replacement branch carries fewer events, so the global counter comes DOWN and an entity the replacement never mentions goes back to what the confirmed block wrote. Both are run against two storage backends (versioned rows in libSQL, versioned rows in a Map), so the four states have to agree and the backend is the only line that differs.

  The input is a replayed stream fixture: the chain is captured once with `captureStream`, serialized once, and every run re-parses the same text, so the comparison is against identical bytes rather than two chain reads.

  **The seam boundary is encoded so that closing it goes red**, since "the boundary is intact" is not otherwise checkable. Four ways, and the first is the load-bearing one: the indexer-server half is constructed with a provider that THROWS on every JSON-RPC method, naming the boundary. Because the same processor and the same core run both ways, a convenience added on the single-process path -- where one would be added -- is exercised again on the split path, where it cannot be answered. The other three: everything crossing the wire is JSON and is asserted to survive the crossing unchanged; the envelope is asserted to be ADR-0004's and to carry no `removed` markers and no `unconfirmedBlocks`, so all reorg information is derived by the receiver; and the receiver is authoritative about the cursor, with a batch starting anywhere else refused and nothing applied.
  - **`EthereumIndexer.expectedFromBlock` is new**, and it is the ADR-0004 primitive the split shape needs: the block the next batch must start at, which a stateless log-fetcher cannot compute because it holds no cursor. `feed()` already refused a batch that started anywhere else (`generateStreamToAppend` enforces it internally); what was missing was a way to ASK, without which the sender would have to hold the cursor itself. It reaches back over the unconfirmed window rather than answering `lastToBlock + 1`, because re-fetching that window is how a reorg is detected at all.

- 33afc5b: A processor's `version` is now REQUIRED, and the indexer reports when the declared version no longer matches the code.

  **Breaking for processor authors, in both authoring surfaces.** `version` becomes a required field on `JSProcessor` (`@etherfold/js-processor`) and on `SQLProcessor` (`@etherfold/processor-sqlite`), and a processor without a non-empty one now throws at construction, naming the processor by its handlers. Add a `version` to each processor object, ideally generated (as `examples/event-processor-nfts` does, from a hash of its own built file) so it cannot be forgotten.

  **Breaking for `EventProcessor` implementors.** `getCodeFingerprint(): string | undefined` is a REQUIRED method, not an optional one. An optional method would be a hole with a polite name: an implementation that never wrote one, or a wrapper that forgot to forward it, would lose drift detection with nothing to show for it. Returning `undefined` is still a valid answer and means "cannot tell", which is never reported as drift. Both cache wrappers (`EventCache`, `ProcessorFilesystemCache`) forward it.

  **Breaking for stored state: every version hash changes, so existing state is discarded once.** Both implementations dropped their fallback constants entirely rather than merely making them unreachable. `${version || 'unknown'}` is gone with the optional version, and `configHash || 'not-configured'` is gone too: the config is now hashed the same way whether or not `configure()` was called, so an unconfigured processor and one configured with `undefined` no longer get different hashes and no longer discard each other's state.

  **New: advisory drift detection for the version an author forgot to bump.** `getCodeFingerprint()` is derived from the processor's own handler sources and persisted as `LastSync.context.processorFingerprint`. On load, when the version hash is UNCHANGED but the fingerprint is not, the core reports at error level through `named-logs` and through a new `indexer.onProcessorDrift` callback, and keeps going. Set `strictProcessorDrift: true` in the indexer config to refuse to start instead.
  - The fingerprint is deliberately NOT part of `getVersionHash()`. A minifier or a transpiler change moves it without changing behaviour, and folding that in would force a full state rebuild on a deploy that changed no logic.
  - **Absence is never drift.** A cursor with no fingerprint, and a processor that answers `undefined`, both report nothing.
  - `processorCodeFingerprint(processor)` and `assertProcessorVersion(processor, implementation)` are exported from `@etherfold/core` for anyone implementing their own `EventProcessor`.
  - `ProcessorContext.version` is now required, since every processor has one.

- 4097ccd: Rename misspelled public types `StreamFecther` → `StreamFetcher` and `ExistingStateFecther` → `ExistingStateFetcher`.

  This is a breaking change for any code importing these types by name (no deprecated aliases are kept). Update your imports accordingly.

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

- cefe0de: Answer "does the indexed state already account for this transaction?", so an app can lay an optimistic update over indexed state without counting it twice.

  `checkTxInclusion(lastSync, queries, finality)` (`@etherfold/core`) returns one verdict per transaction hash: `included`, `absent` or `unknown`, with the basis it was concluded on. `createIndexerState(...).checkTxInclusion(queries)` (`@etherfold/browser`) is the same thing against the cursor the hook is holding and the finality depth the indexer actually runs with, which is also newly exposed as `EthereumIndexer.finalityDepth`.

  Nothing is stored for this and no processor declares anything for it: the answer comes out of `LastSync.unconfirmedBlocks`, which already holds the reorg-eligible window as whole blocks with their events, and every event carries its `transactionHash`. The set maintains itself under reorg, since a reorged-out block leaves the window and a re-included transaction re-enters it.

  The comparison is deliberately NOT against the caller's own receipt. A block height is a local opinion about a chain rather than an identity, and the receipt's block hash is the wrong identity: after a reorg the same transaction can be re-included in a different block, so comparing hashes reports "not indexed" for a transaction that is indexed, which is exactly the double-count. A window hit must also be behind `lastToBlock`, because `feed` publishes the whole new window before it walks the cursor through it.

  Two limits are documented on the function: only transactions that emitted events this indexer indexes can hit (the window is sparse), and `absent` means "not in the window", so a caller must not ask about a transaction older than it, which a transaction the app itself just submitted cannot be.

### Patch Changes

- c681b79: Cache fetched block timestamps, so the unconfirmed window is not re-fetched every round.

  On a node that does not put `blockTimestamp` on the log, `alwaysFetchTimestamps` costs one `eth_getBlockByHash` per block. `getFromBlock` deliberately re-scans back to `latestBlock - finality` on every round to catch reorgs, so the same unconfirmed blocks were fetched again on every single round: indexing 3 blocks over 5 rounds against a Hardhat node cost 15 block fetches, and it now costs 3.

  The cache is keyed by block **hash**, and that is what makes it safe rather than merely smaller: a hash uniquely determines a block, so a cached timestamp cannot become wrong and a reorged-out block's hash simply never appears again. Keying by height would answer a replaced block with the dead branch's timestamp, silently, across exactly the reorgs the re-scan window exists to detect.

  It is bounded by the reorg window rather than by the length of the chain: entries below `latestBlock - finality` are evicted, since `getFromBlock` can never ask for them again, and that is also what evicts reorged-out hashes. A node that supplies timestamps on the log populates nothing at all.

- 9d21d67: Take `blockTimestamp` from `eip-1193`'s own type, dropping the local widening.

  `eip-1193@0.6.6` adds the optional `blockTimestamp` to `EIP1193Log`, so the local intersection type that existed only because the upstream type predated `execution-apis#639` is gone, and the log is read as `IncludedEIP1193Log` directly. The dependency range moves to `^0.6.6`, since the source now relies on that field being declared rather than merely being on the wire.

  No behaviour change. `parseLogBlockTimestamp` still takes `unknown` rather than `EIP1193QUANTITY`, deliberately: the spec (and therefore the type) says hex QUANTITY, while at least one client serves decimal. The type states the contract, the parser handles what actually arrives.

- ca6f981: Distinguish the two ways a reorg is concluded, and report the dangerous one loudly. `generateStreamToAppend` now returns an optional `reorg: {cause, blockNumber, blockHash}` alongside the stream, where `cause` is either `contradiction` (the same height now carries a different hash, which is proof) or `absence` (a block we held is simply not in the re-fetched range, which is an inference).

  The distinction matters because absence is indistinguishable from a sender that under-delivered the range: a truncated `eth_getLogs`, a wrong address or topic filter, a misconfigured chain. Both causes revert state, so an absence-driven revert is logged at `error` level with the range that produced it, while an ordinary hash contradiction stays at `info`. A rising rate of absence-driven reverts means truncation or misconfiguration rather than chain activity.

  Purely additive: the returned object gains a field, and existing destructuring is unaffected.

- eba61c3: Fix typo (`conext` -> `context`) in the chain-mismatch error message thrown by `updateIndexer` when the connected chain differs from the previous indexer context.
- dece521: Fix `createAction` losing its executor's parameter types when the action's argument type is a union.

  `createAction<T, U>` chose the executor signature with `U extends undefined ? ... : ...`. `U` is a NAKED type parameter there, so the conditional DISTRIBUTES: for a union argument type such as `boolean` (`true | false`) it produced a UNION of two signatures rather than one signature taking the union. A union of signatures has no single call signature, so the executor's parameters silently fell back to implicit `any` and `next(...)` demanded the INTERSECTION of the constituents (`never`), refusing every real argument.

  Both conditionals (`Func` and the `execute` parameter) now use the non-distributive `[U] extends [undefined]` form, which keeps `U` whole. No runtime behaviour changes and the public declarations are byte-identical; the internal module's `.d.ts` is the only emitted file that moves.

  Found by the new `pnpm typecheck`, which is the first thing in this repo to typecheck `test/`: `test/promises.test.ts` had been calling `createAction<string, boolean>` since it was written, and nothing checked it.

- 939364a: fix(core): `feed()` dropped every retraction, so the feed path could not revert

  `promiseToFeed` batched the generated stream with `groupLogsPerBlock`, which deliberately skips `removed: true` events. That is correct for logs coming IN from a fetch, where a retraction has no business existing, and wrong for the stream going OUT to a processor, where a `removed` marker is the only instruction a processor ever gets to revert.

  The consequence was that the same stream produced two different states depending on which entry point delivered it: reverted correctly through `indexMore()`, and silently derived from a dead branch through `feed()`. `feed()` is the kept-stream replay on load and the indexer-server's import route, so a reorg that arrived through either was applied and never taken back.

  Retractions are now grouped and delivered by `groupStreamPerBlock`, which keeps them, and keeps a retracted block apart from a re-applied one when they share a hash (which happens when a reorg is detected at the first unconfirmed block and a later one is re-applied unchanged). All retractions in a stream go in a single `process` call regardless of `feedBatchSize`, since a revert is one decision about one fork point and a processor that reverts to the lowest retracted block must not compute it from a partial view. A retraction-only batch no longer drags `lastToBlock` backwards.

- d24872f: Fix a reorg that silently kept dead-branch events in the state. `generateStreamToAppend` detected reorgs by walking the **incoming** block list and comparing it position-by-position against `unconfirmedBlocks`. When a reorg removed a block's logs without replacing them at another block-with-logs (for example the transaction went back to the mempool and was not re-mined yet), the re-fetch legitimately returned a **shorter** list, so the vanished block was never compared with anything: no `removed: true` marker was emitted, the processor kept the state derived from a block that no longer existed, and the block lingered in `unconfirmedBlocks` until it fell outside the finality window and was pruned without ever being retracted, making the corruption permanent. It self-healed only if another block with logs happened to land in the unconfirmed window first, so low-traffic sources were the most exposed.

  Reorg detection is now driven by `unconfirmedBlocks` and matches incoming blocks by block **number**: a missing entry (the block no longer carries any of our logs) and a differing hash (the block was replaced) are both treated as a reorg at that block. Blocks outside the re-fetched `[fromBlock, toBlock]` range are skipped rather than judged missing, since the re-fetch proves nothing about them. Behaviour for the already-covered case (same height, new hash) is unchanged.

- 78d8377: Align `EthereumIndexer.updateProcessor` with `updateIndexer`: it now calls `disableProcessing()` first (so a racing index/feed tick cannot interleave with the processor swap) and re-enables processing afterwards. The processor instance is now swapped only once a change has been decided, instead of being replaced before the version-hash check — so a no-op (same-version) update no longer replaces the running instance mid-flight.

  When the new processor has the same version hash as the current one, the swap is skipped and a warning is logged (in case the developer changed the processor but forgot to bump its version hash). A new `updateProcessor(newProcessor, {force: true})` option swaps, clears, and reloads regardless of the version hash.

- 3de4c35: Several bug fixes in the core indexer:
  - `getNewToBlockFromError`: only treat `-32602` errors as block-range hints when the message actually looks like one (avoids mis-parsing unrelated "invalid params" errors), and fix the `"block range too large"` detection that always evaluated truthy.
  - `fetchLogsFromProvider`: deduplicate block/transaction extra-data fetches by hash instead of by block number, so every distinct block hash gets its timestamp (fixes missing `blockTimestamp` when two hashes share a block number, e.g. after a reorg in the unconfirmed window).
  - `createAction`: forward falsy-but-valid arguments (`0`, `''`, `false`) to the executor instead of dropping them based on truthiness; and fix the `next()` (queue) path that fell through and executed the queued action twice / broke serialization.
  - Log previously-swallowed listener and `tokenURI` fetch errors via `named-logs` instead of empty `catch {}`.

- bc118e4: Declare the packages the published types import, so installing them actually typechecks.

  A type-only import is erased from the emitted `.js` but survives in the emitted `.d.ts`. These packages name types from `abitype`, `eip-1193` and `@etherfold/core` in their public declarations while listing those as `devDependencies`, so a consumer installing them got declaration files importing packages that were never installed.

  Moved to `dependencies`: `abitype` and `eip-1193` in `@etherfold/core`, `eip-1193` in `@etherfold/browser`, and `@etherfold/core` in `@etherfold/utils`.

  Measured against a packed tarball installed under pnpm's isolated linker with `hoist=false`, `tsc --strict --skipLibCheck false` reported 11 errors (6 for `abitype`, 5 for `eip-1193`) before and none after.

  The bug was hard to see from inside the workspace, which is why it lasted. pnpm keeps a hoisted fallback directory holding every transitive package, so an undeclared import still resolves as long as anything else in the tree depends on it: `abitype` was masked that way by viem and failed only with hoisting off, while `eip-1193`, which nothing else depends on, failed everywhere. `skipLibCheck: true`, which most consumers set, suppresses the diagnostics entirely and silently degrades the affected types instead.

  A test now asserts, for every package in the workspace, that each bare specifier in its built `.d.ts` files is a declared dependency. It found the `@etherfold/utils` case, which a search for the two known package names had missed.

## 0.6.21

### Patch Changes

- forgot to build

## 0.6.20

### Patch Changes

- base rpc range to large

## 0.6.19

### Patch Changes

- new loading state + CatchingUp for browser-indexer

## 0.6.18

### Patch Changes

- allow to reset indexer

## 0.6.17

### Patch Changes

- log when reset logLevel

## 0.6.16

### Patch Changes

- skipGenesisCheck

## 0.6.15

### Patch Changes

- fix typo

## 0.6.14

### Patch Changes

- fix genesisHash fetch

## 0.6.13

### Patch Changes

- let specify genesisHash as source param, useful for local chain

## 0.6.12

### Patch Changes

- latest deps

## 0.6.11

### Patch Changes

- fix fromBlockFromContracts

## 0.6.10

### Patch Changes

- fix fromBlock computation

## 0.6.9

### Patch Changes

- fix history splice

## 0.6.8

### Patch Changes

- reorg + add streams server (wip)

## 0.6.7

### Patch Changes

- improve processor import to work in pnpm + startBlock fix

## 0.6.6

### Patch Changes

- do not trigger subscribe when zero event stream

## 0.6.5

### Patch Changes

- fix duplicate event name issue

## 0.6.4

### Patch Changes

- c81fb4d: use state field name instead of data

## 0.6.3

### Patch Changes

- further chainId check

## 0.6.2

### Patch Changes

- fix fromBlock negative

## 0.6.1

### Patch Changes

- cleanup exports

## 0.6.0

### Minor Changes

- release

## 0.5.6

### Patch Changes

- fixes

## 0.5.5

### Patch Changes

- fix

## 0.5.4

### Patch Changes

- fix

## 0.5.3

### Patch Changes

- fixes + implement filters option

## 0.5.2

### Patch Changes

- fix

## 0.5.1

### Patch Changes

- remove duplicate contract addresses and topics for log fetching

## 0.5.0

### Minor Changes

- use viem + aitype for type-safe experience

## 0.4.3

### Patch Changes

- fix

## 0.4.2

### Patch Changes

- reorg

## 0.4.1

### Patch Changes

- allow access to state from processors that declare it

## 0.4.0

### Minor Changes

- chainId specified

## 0.3.11

### Patch Changes

- fix again

## 0.3.10

### Patch Changes

- fix

## 0.3.9

### Patch Changes

- fix

## 0.3.8

### Patch Changes

- typings

## 0.3.7

### Patch Changes

- types

## 0.3.6

### Patch Changes

- fix topics

## 0.3.5

### Patch Changes

- use eip-1193 types

## 0.3.4

### Patch Changes

- force new version

## 0.3.3

### Patch Changes

- republish with new types

## 0.3.2

### Patch Changes

- export type as types

## 0.3.1

### Patch Changes

- allow to specify type on EventWithId

## 0.3.0

### Minor Changes

- new release

## 0.0.15

### Patch Changes

- use monorepo
