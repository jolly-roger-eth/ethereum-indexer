# Findings: server / CLI batch-indexing path (one-shot + long-running)

Review of the **batch / long-running** indexing path in `ethereum-indexer-cli` and
`ethereum-indexer-server`, plus the `keepState` / `keepStream` persistence they rely on. These
packages are **not** live-reconfigurable (intentionally — see `tasks/audit-server-cli-batch-indexing.md`),
so this review is about the correctness of the batch path itself, not live reload.

**Reviewed:**
- `packages/ethereum-indexer-cli/src/index.ts` — `init()` (processor/source/keepState wiring) and
  `run()` (the `indexMore()` loop).
- `packages/ethereum-indexer-cli/src/cli.ts` — entrypoint / `commander` options / exit behaviour.
- `packages/ethereum-indexer-cli/src/utils/bn.ts` — BigInt JSON replacer/reviver.
- `packages/ethereum-indexer-server/src/server/simple.ts` — `SimpleServer`: setup, HTTP routes,
  auto-index loop.
- `packages/ethereum-indexer-server/src/server.ts` — `runServer()` wiring.
- Supporting: `ethereum-indexer-utils` `contextFilenames()` / `loadContracts()`, core
  `EthereumIndexer.load()` / `indexMore()` / `indexerMatches()` (`packages/ethereum-indexer/src/indexer.ts`).

**Test status:** neither `ethereum-indexer-cli` nor `ethereum-indexer-server` has any tests or a real
`test` script wired (the server's is `echo "Error: no test specified"`). The core engine has a good
vitest harness (`packages/ethereum-indexer/test/*`, fake EIP-1193 provider) that the actionable
items below can reuse.

---

## How version / context invalidation works (context for the snapshot items)

Two independent layers decide whether a persisted snapshot is reused:

1. **Filename layer (CLI only).** The CLI's `keepState.fetch`/`save` derive the state filename from
   `contextFilenames(context)`, which hashes `source` + `config` + `version` (NOT the processor
   version hash). So a changed **source** (new deploy) or **stream config** ⇒ a *different filename*
   ⇒ `fetch` misses ⇒ clean cold start (old file is simply left on disk, never deleted).
2. **Content layer (core `load()`).** Whatever `fetch` returns is still validated inside core
   `load()`: it is only reused if `processorHash === loadedLastSync.context.processor` **and**
   `indexerMatches(lastToBlock, context)` (source-hash + config-hash match). On mismatch the state
   is discarded (`processor.clear()`) and a fresh sync starts.

Net: the **processor version hash** is the layer that protects against a stale snapshot from an old
processor — and it is checked in core, not in the filename. This mostly works, but see HIGH-2 and
MEDIUM-3.

---

## Bugs / correctness risks

### HIGH-1 — CLI: no atomic write of the state file; CI can commit a half-written snapshot
`ethereum-indexer-cli/src/index.ts` `keepState.save`:
```ts
fs.writeFileSync(lastSyncFile, JSON.stringify(data.lastSync, ...));
fs.writeFileSync(stateFile, JSON.stringify(data, ...));   // <- big file, written in place
```
`save` is called on **every** `indexMore()` (i.e. repeatedly during the run), writing directly over
the destination files. Two distinct problems for the `stratagems-snapshots` CI use case:
- **Non-atomic write:** if the process is killed (CI timeout, OOM, Ctrl-C) mid-`writeFileSync`, the
  on-disk `state.json` is left **truncated / invalid JSON**. The next run's `fetch` does
  `JSON.parse` inside a `try/catch` that swallows *all* errors and returns `undefined` — so a
  corrupt snapshot silently degrades to a full cold re-index (expensive but not wrong). Worse: if CI
  **commits whatever is on disk** after a kill, a corrupt snapshot is published and served to the
  browser app.
- **lastSync / state can disagree:** `lastSyncFile` is written first, then `stateFile`. A crash
  between the two leaves a `lastSync` ahead of the `state`. (The CLI's own `fetch` reads both from
  the single `stateFile` so it is internally consistent, but any external consumer reading
  `lastSyncFile` separately — or the snapshots pipeline — can observe the skew.)

**Fix direction:** write to a temp file in the same directory and `fs.renameSync` into place
(atomic on POSIX same-filesystem); write both files via temp+rename; consider writing only at the
end / on an interval rather than every block. TDD: a test that simulates a partial write / asserts
the destination is never observed truncated.

### HIGH-2 — `keepState` snapshot has **no integrity/version envelope** of its own
The CLI snapshot file is `{lastSync, state, history}` with **no schema version, no app/processor
version, no checksum**. Protection against staleness relies entirely on:
- the filename hash (source/config/version), and
- core `load()` comparing `context.processor` to the live processor hash.

Gaps:
- If a processor changes its **state shape** but keeps the **same `getVersionHash()`** (easy to do by
  accident — the version hash is processor-author-controlled), core `load()` accepts the old state
  as valid and feeds it to the new processor ⇒ silent corruption / runtime errors deep in
  `process()`. The snapshots pipeline would happily publish it.
- The `try/catch` in `fetch` treats *every* read/parse failure identically as "no snapshot" — a
  genuinely corrupt or partially-readable file is indistinguishable from a first run. No log, no
  signal.

**Fix direction:** add a small envelope (`{format: 1, processor: <hash>, savedAt, ...}`) and validate
it in `fetch`; at minimum log when a parse fails instead of silently swallowing. Coordinate with the
core `context.processor` check so we don't duplicate it.

### HIGH-3 — Server `/feed` reads the body from the wrong place (route is broken)
`server/simple.ts` `/feed`:
```ts
const eventStream = ctx.body.events;   // <- ctx.body is the *response* body, undefined here
```
Every other route reads `ctx.request.body` (e.g. `/query`, `isAuthorized`). `koa-bodyparser`
populates `ctx.request.body`, not `ctx.body`. So `ctx.body.events` throws `Cannot read properties of
undefined (reading 'events')` for any real `/feed` call. The route is effectively dead.
**Fix:** `const eventStream = (ctx.request.body as any).events;` (+ validate it's an array). Small,
testable.

### MEDIUM-1 — CLI: exit code is always 0, even on failure ("DONE" on error path)
`cli.ts`:
```ts
run(options).then(() => { console.log('DONE'); });
```
There is **no `.catch`** and **no `process.exit(1)`** on failure. An unhandled rejection in `run()`
(bad node URL, RPC error, processor throw, write failure) prints a stack but Node's default exit code
for an unhandled rejection is version/flag-dependent and easy to mask. For CI this is dangerous: a
**failed index can look like success**, and a green CI step can commit a stale/empty snapshot.
Conversely, on success the process may **not exit** promptly because the `JSONRPCHTTPProvider`'s
rate-limit timers / sockets can keep the event loop alive (no explicit `process.exit(0)`).
**Fix direction:** `run(options).then(() => { console.log('DONE'); process.exit(0); }).catch((err) =>
{ console.error(err); process.exit(1); });`. TDD: hard to unit-test the process boundary; at least
unit-test that `run()` rejects on the error paths.

### MEDIUM-2 — CLI `run()`: stale `latestBlock` at startup + terminates at a *moving* tip
```ts
const latestBlockNumberAsHex = await eip1193Provider.request({method: 'eth_blockNumber'});
let newLastSync = {...lastSync, latestBlock: lastBlockNumber};
while (newLastSync.lastToBlock < newLastSync.latestBlock) {
    newLastSync = await indexer.indexMore();   // <- overwrites latestBlock with the *live* tip
}
```
- The startup `eth_blockNumber` is **redundant**: `indexMore()` re-fetches the latest block each call
  and returns it in `newLastSync.latestBlock`, so after the first iteration the startup value is
  discarded. (Minor: one wasted RPC + slightly confusing code.)
- The loop condition uses the **live** tip each iteration. On a busy chain that keeps advancing, "to
  completion" means "until we momentarily catch the moving head," and with finality trimming
  (`getFromBlock` backs off by `finality`, default 17) the loop can spin doing tiny increments near
  the tip. For the **snapshot** use case this is usually fine (snapshots are taken behind finality),
  but the termination semantics are "catch the live head," not "index up to the block number observed
  at start." Worth documenting and/or pinning a target block.
- **No retry / no error isolation:** unlike the server's `index()` loop, a single `indexMore()`
  rejection (transient RPC blip) propagates out of the loop and aborts the whole run (→ see
  MEDIUM-1). A one-off network error fails the batch.

**Fix direction:** decide the intended contract (index to start-tip vs live-tip), drop the redundant
startup call or use it as a fixed target, and add bounded retry around `indexMore()` for transient
errors (mirroring the server but with a max-attempts cap — see MEDIUM-4).

### MEDIUM-3 — `config` hash in `contextFilenames` covers the *stream* config, not processor config
`contextFilenames` hashes `context.config` which is the stream/indexer config. The **processor's**
own configuration (the CLI calls `processorFactory()` with no args; the server calls
`processorFactory(this.config.folder)`) is **not** part of the filename or the `indexerMatches`
check. If a processor's behaviour depends on construction-time config that isn't reflected in its
`getVersionHash()`, a snapshot from one config can be reused under another. (Closely related to
HIGH-2; same root cause — reliance on author-maintained `getVersionHash()`.)

### MEDIUM-4 — Server auto-index loop: unbounded tight-ish retry, never backs off, never surfaces
`server/simple.ts` `index()`:
```ts
} catch (err) {
    namedLogger.info('server error: ', err);          // logged at info, easy to miss
    this.indexingTimeout = setTimeout(this.index.bind(this), 1000);   // retry forever
    return;
}
```
- A persistent failure (bad RPC, chain mismatch, processor bug) retries **every 1s forever** with no
  backoff and no escalation. The `/` status route still reports `indexing: true`, so an operator
  polling status sees "indexing" while it is actually stuck in a retry loop. Errors are logged at
  `info`, not `error`.
- The healthy path `setTimeout(this.index.bind(this), 1)` (1ms) when behind is essentially a busy
  loop while catching up — acceptable but worth noting for CPU.
**Fix direction:** exponential backoff, log at `error`, expose last-error in the status response so
`/` reflects a stuck/failed state.

### MEDIUM-5 — Server: `/indexMore` vs the auto-index loop are not mutually safe under all states
`/indexMore` guards with `if (this.indexing) { return 'Indexing Already' }`. But `this.indexing` is
set `true` only inside the auto-index `index()` method; a manual `/indexMore` does **not** set
`this.indexing`, so:
- Two concurrent **`/indexMore`** HTTP calls can both pass the guard and call
  `indexer.indexMore()` concurrently on the same indexer instance. The core serializes some actions
  internally, but the server makes no attempt to serialize, and both will write `this.lastSync`
  (last-writer-wins). At minimum the responses can be misleading.
- `/feed` and `/replay` guard on `this.indexing` (auto-loop) but not on an in-flight manual
  `/indexMore`.
**Fix direction:** a single in-flight flag/promise covering *all* indexing entrypoints (auto loop +
manual `/indexMore` + `/feed` + `/replay`), so they serialize and report truthfully.

### LOW-1 — Server: API key handling
- When `ETHEREUM_INDEXER_API_KEY` is unset, a random UUID is generated and **printed to stdout**;
  fine for dev, but combined with `disableSecurity` defaulting to `false` it means a freshly started
  server is "secured" by a key only visible in the logs.
- `isAuthorized` compares with `apiKeys.includes(apiKeyProvided)` — a plain string compare (not
  constant-time). Low severity for this use case but worth noting.
- Read routes `/`, `/get/:id`, `/query` are **unauthenticated** (only the admin/mutating routes call
  `isAuthorized`). Probably intentional (public read API) — confirm and document.

### LOW-2 — Server: thrown errors in routes become 500s with stack leakage
Several routes `throw new Error('no indexer' / 'no processor' / 'no cache')` instead of returning a
shaped error body like the authorized routes do (`{error: {code, message}}`). Koa will turn these
into 500s (and may leak stack traces depending on env). Inconsistent with the `{error:{code}}`
convention used elsewhere.

### LOW-3 — `bnReviver` is heuristic and can mis-parse legitimate strings
`utils/bn.ts` revives any string that "looks like digits… ending in `n`" into a BigInt. A legitimate
string value that happens to match (e.g. an address-like or user-supplied field ending in `n`, or
`"123n"` meant as text) would be silently converted to a BigInt on read. Low risk for the current
state shapes but a latent data-fidelity bug; the envelope/format work (HIGH-2) could move to a more
explicit encoding.

### LOW-4 — Duplication between CLI `init()` and server `setupIndexing()`
The processor-module loading, `contractsDataPerChain`/`contractsData` resolution, chainId fetch, and
source construction are **copy-pasted** between `cli/src/index.ts` and `server/src/server/simple.ts`
(the CLI even has a `// TODO ethereum-indexer-server could reuse`). Divergence risk: e.g. the server
passes `this.config.folder` to the processor factory, the CLI passes nothing (see MEDIUM-3). Worth
extracting a shared helper in `ethereum-indexer-utils`. (Also flagged in
`tasks/findings/todo-triage.md` under "Server / streams packages".)

### LOW-5 — CLI: old snapshot files are never cleaned up
Because the filename is content-hashed (source/config/version), changing any of them produces a
**new** file and orphans the old one. Over many deploys the `folder` accumulates stale
`*-state.json` / `*-lastSync.json`. Harmless correctness-wise but unbounded growth, and for the
committed-snapshots repo it means dead files get committed unless pruned.

---

## Suggested priority order for fixes (each via TDD-with-confirmation-gates)

_Status: implemented in `tasks/fix-server-cli-batch.md` (now archived). Each fix landed via TDD
(characterization tests first, then a failing test, then the fix) with a changeset._

1. ✅ **HIGH-3** server `/feed` body bug — fixed (reads `ctx.request.body`, validates array).
2. ✅ **HIGH-1** CLI atomic write (temp + rename) — fixed; extracted `createFileKeepState`.
3. ✅ **MEDIUM-1** CLI exit codes — fixed via `main()` (`exit(0)` success / `exit(1)` failure).
4. ✅ **HIGH-2 / MEDIUM-3** snapshot envelope + don't-swallow-parse-errors — done, backward-compatible
   (envelope `{format,processor,savedAt,...}`; reads legacy bare form; logs corrupt files).
5. ✅ **MEDIUM-4 / MEDIUM-5** server backoff + single in-flight indexing guard + `lastError` in status.
6. ✅ **MEDIUM-2** CLI loop bounded retry + dropped redundant `eth_blockNumber` (extracted
   `indexToTip`; live-tip termination contract documented/kept).
7. ✅ **LOW-1 / LOW-2** — constant-time api-key compare; shaped `503` instead of thrown `500`.

**Deferred (not done):**
- **LOW-3** heuristic `bnReviver` — left as a documented known limitation; changing the encoding is
  risky and better folded into a future explicit-encoding change.
- **LOW-4** CLI↔server setup duplication — spun out to `tasks/refactor-cli-server-setup-duplication.md`
  (extract a shared helper in `ethereum-indexer-utils`); the server's `createProvider` seam is a
  first step.
- **LOW-5** orphaned snapshot files — spun out to `tasks/snapshot-prune-script.md` (a manually-run
  prune script; needs investigation into how to safely *detect* outdated snapshots first).

**Out of scope** (per the task): adding `updateIndexer`/`updateProcessor`/auto-reconfigure to server
or CLI. They are intentionally restart-to-reconfigure.

Each behaviour change to a published package needs a **changeset**. No fixes implemented yet — this
is the read-only review deliverable.
