---
title: Address state by block hash, height or time
slug: block-addressing-hash-height-time
spec: historical-state-database
blockedBy: [sql-versioned-state-store]
covers: [1, 2, 3]
---

> Completed in `df47021` (the addressing) and `4a1bcf2` (ADR-0015, which it forced), extending `@ethereum-indexer/state-store-sqlite` in `packages/state-store-sqlite/`. `getAsOf` and `queryAsOf` widened from `blockNumber: number` to a `BlockAddress` (`101`, `{number}`, `{hash}`, `{timestamp}`), joined by `resolveBlockNumber`, `getBlock`, `NoSuchBlockError`, `normalizeBlockHash` and `normalizeBlockTimestamp` in the new `src/blocks.ts`. 20 new tests in 2 files (67 total, up from 47), against real in-memory libSQL; no existing test changed, since widening a parameter is backward compatible. Each new test verified load-bearing by mutating the source. Changeset `.changeset/block-addressing-hash-height-time.md` (minor).

## What to build

The query surface a downstream service actually uses: read the computed state **as of a block hash, a block height, or a timestamp**. All three resolve internally to a block number through one canonical block table, so the store keeps exactly one addressing mechanism.

The block table records `{number, hash, parentHash, timestamp}` and holds rows **only for blocks that carry our logs**, not for every chain block. That is sufficient and deliberate: state only changes at blocks where our events occur, so "state as of time T" is exactly "state as of the latest recorded block with `timestamp <= T`", and a consumer only ever pins a hash it saw on a log we delivered. Storing every header would be tens of millions of rows for no added answer.

Resolution rules:

- **hash**: the reorg-proof identifier, and the one consumers should store. An unknown hash resolves to "no such block", which is the correct answer for a reorged-out block rather than an error to paper over.
- **height**: direct, and unambiguous once finalized.
- **timestamp**: the latest recorded block with `timestamp <= T`.

Timestamps come from `blockTimestamp` on the logs themselves (modern clients return it; it is in the execution-apis spec), so no extra `eth_getBlockByNumber` round-trip. Normalise on ingestion: at least one client returned it decimal where others use hex.

## Acceptance criteria

- [x] State can be read as of a block hash, a height and a timestamp, returning identical results when the three identify the same block. (`test/block-addressing.test.ts`, for a point read and for a whole-table query)
- [x] An unknown or reorged-out **hash** resolves to "no such block", distinguishably from "that block exists and the entity was absent". (`test/block-addressing.test.ts`: an absent entity at a known hash is `undefined`; an unknown hash throws `NoSuchBlockError` with `reason: 'unknown-hash'`)
- [x] A timestamp between two recorded blocks resolves to the earlier one; a timestamp before the first recorded block resolves to nothing. (`test/block-addressing.test.ts`, including the tie case, which resolves to the highest block number)
- [x] The block table gains a row only for blocks that carry our logs, and that is asserted, not just documented. (`test/block-addressing.test.ts` "is exactly the blocks handed to the store, gaps included", plus the zero-mutation block that is still recorded and still resolvable by hash)
- [x] `blockTimestamp` is taken from the log and normalised, with a test covering the decimal-vs-hex discrepancy. (`test/block-timestamp.test.ts`, including that a bare decimal string is not read as hex)
- [x] Reverting past a block removes its row, so a hash that has been reorged out stops resolving. (`test/block-addressing.test.ts`; verified load-bearing by dropping the `_blocks` DELETE from `revertToStatements`, which turns 4 tests red)
- [x] Tests run against real local SQLite/libSQL in the repo's vitest style. (in-memory libSQL via `remote-sql-libsql`, never a mock)

## Blocked by

- `sql-versioned-state-store` (the range predicate this resolves into, and the same package).

## Prompt

> Add block addressing to the versioned-row state store in the `ethereum-indexer` monorepo, so state can be queried as of a block hash, a height, or a timestamp.
>
> FIRST, check this task against current reality: read `docs/design/historical-state-database.md` §3, and confirm `sql-versioned-state-store` landed as assumed. If it did not, route to needs-attention.
>
> All three axes resolve to a block number through one canonical block table `{number, hash UNIQUE, parentHash, timestamp}`, then run the store's existing as-of predicate. The table holds rows **only for blocks that carry our logs**. This is a deliberate decision with a proof behind it: state only changes at blocks where our events occur, so the latest recorded block at or before T yields the same state as the true block at T, and a consumer only ever pins a hash it saw on a log we served. Do not "fix" this by storing every header; it would be tens of millions of rows for no additional answer.
>
> Hash is the identifier consumers should store, and the reason is worth preserving in the code's documentation: pinning by **number** means a reorg silently changes what "state at 18,000,123" refers to, while pinning by **hash** makes the lookup correctly return nothing, which is itself the signal that whatever the consumer recorded is now invalid. Make "no such block" a distinct answer from "block known, entity absent".
>
> Timestamps come from `blockTimestamp` on the log (reth 2024, go-ethereum 1.16, `execution-apis#639`), so no second round-trip is needed; normalise decimal-vs-hex on ingestion.
>
> Test against real local SQLite/libSQL in the repo's vitest style, add a changeset, and do not commit without confirmation.

## Decisions

Non-obvious choices the task did not specify, transcribed from the builder's final report.

1. **An unresolvable address throws on the read path; `resolveBlockNumber` is the soft form.** A discriminated result would have changed every existing return type (and the 47 tests); `undefined` cannot express both answers; resolve-first-only makes the safe path opt-in. Escalated to **ADR-0015**, because it is a public API contract the future HTTP layer inherits (an unresolvable hash is its own status, not `200` with an empty body).
2. **The three axes are deliberately not equally fallible.** A height resolves to itself with no lookup and never throws (every height is a valid point on the version ranges); a hash needs a row; a timestamp needs one at or before T. `NoSuchBlockError.reason` keeps `unknown-hash` and `no-recorded-block-at-or-before` distinguishable. Recorded in ADR-0015.
3. **A timestamp before the first recorded block throws rather than answering "empty state".** The store cannot honestly claim state was empty then: it may have been started mid-chain or pruned. Callers wanting the soft answer use `resolveBlockNumber`.
4. **Which blocks get a row is the caller's judgement, documented on `applyBlock`.** The store records every block handed to it, including zero-mutation ones, and nothing else. Inferring "carries our logs" from a non-empty mutation list would make exactly the pinnable-but-inert hashes unresolvable. `test/batch.test.ts` stands unchanged; the new tests pin the sparse-`_blocks` half of the same contract.
5. **Timestamp normalisation lives at this seam** as exported `normalizeBlockTimestamp`, because `BlockPointer.timestamp: number` is where the numeric contract is defined. The not-yet-built ingestion seam calls it once rather than re-deriving the rule. `0x` means hex, bare digits mean decimal, anything else throws (never defaults to 0); the prefix is the only signal, since `'1705375936'` is valid hex too and the readings are millennia apart.
6. **Block hashes are folded to lower case on write and lookup** (`normalizeBlockHash`). Hex case is meaningless in a hash but SQL comparison is not, so an echoed-back upper-case hash would fail to resolve and read as a reorg: the one wrong answer this design cannot afford. Also in ADR-0015.
7. **Resolution is a separate query, costing one round-trip on the hash and timestamp axes.** A sub-select would save it and re-introduce the bug: matching nothing makes the predicate false, turning "no such block" back into "entity absent". Noted on `resolveForRead`.
8. **`getBlock(address)` added** beyond the literal ask, so "pin the hash" is an actionable instruction: a consumer resolves by time or height once and stores the hash it gets back.

## Follow-on

Two premises for `sql-backed-event-processor` (now unblocked) were found doubtful while building this, and should be checked before it is built rather than assumed:

- The design says `blockTimestamp` comes free on the log. In the code today, `packages/ethereum-indexer/src/indexer.ts` populates `event.blockTimestamp` only when `config.stream.alwaysFetchTimestamps` is set, and fills it from a separate `getBlocks` call rather than from the log's own field; it is optional on `BaseLogEvent`. `_blocks.timestamp` is `NOT NULL`, and a missing timestamp breaks the time axis silently.
- Neither `LogEvent` nor `EventBlock` carries a `parentHash`, while `_blocks.parentHash` is `NOT NULL` and the store defaults it to `''`. Nothing currently performs the chain-linkage check that column exists for.
