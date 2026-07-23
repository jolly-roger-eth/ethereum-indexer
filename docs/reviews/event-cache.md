# Findings: EventCache review

**Reviewed:**
- `packages/ethereum-indexer-db-utils/src/processor/EventCache.ts` (~210 LOC)
- `packages/ethereum-indexer-db-utils/src/cache/StreamDBCache.ts` (~71 LOC)
- `packages/ethereum-indexer-db-utils/src/db/Database.ts` (the DB interface)

**Status of the code:** functional prototype; PouchDB-ish (`_rev`, `$gte`/`selector` queries). No
tests. Several TODOs (transactional writes, `extra` field not persisted, timestamp refetch on replay).

> Captures how event-stream caching works today, to feed into `plan-historical-state-database.md`
> (the `keepStream`/`ExistingStream` mechanism) and to clarify how the trigger system's replay needs
> relate to it.

## Important: there are TWO different cache mechanisms here

They are easy to confuse but serve different roles:

1. **`StreamDBCache.setupCache()`** → returns an `ExistingStream<ABI>` (`saveNewEvents` / `fetchFrom`
   / `clear`). This is the **`keepStream`** mechanism the *core indexer* consumes (see
   `ProvidedIndexerConfig.keepStream` and `ExistingStream` in
   `packages/ethereum-indexer/src/types.ts`). The core engine calls `fetchFrom` on load and
   `saveNewEvents` as it indexes. It is purely a **raw event-stream store** — no processing, no batches.

2. **`EventCache`** → an `EventProcessor` *wrapper* (decorator). It wraps another processor, forwards
   `process()` to it, and **also** persists every event into its own DB keyed by batch, so it can
   **replay** the whole stream through the processor later (e.g. after a processor version change,
   recompute state without re-fetching logs). This is processor-side, not the core `keepStream`.

Both store events with the same doc shape and `_id = blockHash + logIndex`, and both persist a
`lastSync` doc. The duplication between them is notable (see risks).

## How EventCache works today

- **`process(eventStream, lastSync)`**: forwards to the wrapped processor, then writes each event to
  `eventDB` tagged with the current `batchCounter`, increments the counter (only if there were
  events), and upserts `lastSync` (with `batch` count).
- **`load()`**: tries the wrapped processor's `load` first; if that returns nothing, it reads the
  cached `lastSync`, restores `batchCounter`, and calls `replay()`.
- **`replay()`**: resets the wrapped processor, then for each batch `0..lastSync.batch` loads that
  batch's events, sorts them by `(blockNumber, logIndex)`, and re-`process()`es them.

## Bugs / correctness risks found

1. **`_id = event.blockHash + event.logIndex` is a string-concat collision risk.** Concatenating two
   numbers/hex without a separator can collide (`"0xabc" + "12"` vs `"0xab" + "c12"` style ambiguity is
   avoided by fixed hash length, but `logIndex` is a raw number appended to a hex string — fragile).
   Both `EventCache` and `StreamDBCache` share this. Should be a delimited composite key.

2. **`removed` (reorged) events are stored but replay does not handle them.** `process()` persists
   events including `removed: true`. On `replay()`, those `removed` events are fed back to
   `processor.process()` mixed in — but the per-batch sort by `(blockNumber, logIndex)` does **not**
   preserve the original removal/append ordering relative to the reorg, and there is no reconstruction
   of `unconfirmedBlocks` (replay passes `unconfirmedBlocks: []`). Replaying a cache that contains
   reorgs may not reproduce the same state. **This is the highest-risk area** and needs explicit
   reasoning/tests.

3. **`replay()` swallows errors** (`catch (err) { console.error(...) }`) and then returns whatever
   `lastOutcome` was — a mid-replay failure silently yields a partial state presented as success.

4. **Batch boundaries are an artifact of fetch chunking, not semantics.** A "batch" = one
   `process()` call = one indexer fetch window. Replaying batch-by-batch reproduces the *number of
   process calls*, which the processor may treat differently than one big call (e.g. state emitted per
   batch). Probably fine, but couples replay correctness to fetch chunking.

5. **`extra` field is dropped** (`// extra: event.extra, // TODO`) in both caches. Any processor
   relying on prefetched `extra` data will behave differently on replay/`fetchFrom` than on live
   indexing.

6. **Non-atomic writes** (`// TODO make it transactional`). A crash mid-`process` can leave the event
   docs and `lastSync`/`batch` counter inconsistent (e.g. events written but counter not advanced, or
   vice versa) → replay reads a wrong batch count.

7. **`replay()` empty-batch handling**: batches with zero events are skipped, but `batchCounter` was
   only incremented when events existed — so batch indices are dense. OK, but the invariant (counter
   == number of non-empty process calls) is implicit and undocumented.

8. **`load()` ignores source/streamConfig matching** (`// TODO check if source matches old sync`) —
   same gap as `EventProcessorOnDatabase`. A cache from a different source/config could be replayed
   against the wrong context. The core engine does some context-matching on its own `keepStream`, but
   `EventCache` (processor-side) does not.

## Implications for the historical-state DB plan

- **Separate the two concerns explicitly in the plan.** The core `keepStream`/`ExistingStream` (raw
  event store, `StreamDBCache`) is distinct from processor-side replay (`EventCache`) and distinct
  again from historical *state* storage (`RevertableDatabase`). The plan's data model should be clear
  about which layer it is replacing/evolving:
  - raw event log (for replay / recompute) ↔ `StreamDBCache` / `EventCache`'s event store,
  - historical *state* (validity ranges) ↔ `RevertableDatabase`.
  A SQL/D1 design could unify these (an `events` table + a `state_versions` table), which is worth
  calling out as an option.
- **Replay + reorg is unsolved here.** If the historical-state design relies on replay to rebuild
  state (one of the data-model options), it must specify how reorged (`removed`) events are
  represented and replayed deterministically — the current cache does not do this safely (risk #2).
- **`lastSync` persistence pattern** (upsert a single `lastSync` doc with `_rev`) recurs in all three
  components; the plan should define one canonical sync-metadata table.
- **Composite event key** should be defined properly (delimited `(blockHash, logIndex)` or
  `(blockNumber, logIndex)`) — relevant to the D1 schema and to dedup/idempotency for the
  watcher→processor protocol (the watcher/processor split needs idempotent event ingestion anyway).
- **Atomicity**: the watcher→processor + D1 design must make event-append + lastSync + state-write
  atomic per block/batch (today it's best-effort), which matters for crash recovery and exactly-once.

## Suggested follow-ups (separate from the plan)

- Characterization tests (in-memory `Database` stub) for `process` then `replay` round-trip, including
  a reorg (`removed`) scenario that currently likely mis-replays (TDD risk #2).
- Make `replay()` fail loudly instead of swallowing errors.
- Use a delimited composite `_id`.
- Decide whether `EventCache` and `StreamDBCache` should share one implementation.

_(Follow-ups should likely wait until the historical-state DB plan decides whether these are evolved
or superseded.)_
