---
title: Address state by block hash, height or time
slug: block-addressing-hash-height-time
spec: historical-state-database
blockedBy: [sql-versioned-state-store]
covers: [1, 2, 3]
---

## What to build

The query surface a downstream service actually uses: read the computed state **as of a block hash, a block height, or a timestamp**. All three resolve internally to a block number through one canonical block table, so the store keeps exactly one addressing mechanism.

The block table records `{number, hash, parentHash, timestamp}` and holds rows **only for blocks that carry our logs**, not for every chain block. That is sufficient and deliberate: state only changes at blocks where our events occur, so "state as of time T" is exactly "state as of the latest recorded block with `timestamp <= T`", and a consumer only ever pins a hash it saw on a log we delivered. Storing every header would be tens of millions of rows for no added answer.

Resolution rules:

- **hash**: the reorg-proof identifier, and the one consumers should store. An unknown hash resolves to "no such block", which is the correct answer for a reorged-out block rather than an error to paper over.
- **height**: direct, and unambiguous once finalized.
- **timestamp**: the latest recorded block with `timestamp <= T`.

Timestamps come from `blockTimestamp` on the logs themselves (modern clients return it; it is in the execution-apis spec), so no extra `eth_getBlockByNumber` round-trip. Normalise on ingestion: at least one client returned it decimal where others use hex.

## Acceptance criteria

- [ ] State can be read as of a block hash, a height and a timestamp, returning identical results when the three identify the same block.
- [ ] An unknown or reorged-out **hash** resolves to "no such block", distinguishably from "that block exists and the entity was absent".
- [ ] A timestamp between two recorded blocks resolves to the earlier one; a timestamp before the first recorded block resolves to nothing.
- [ ] The block table gains a row only for blocks that carry our logs, and that is asserted, not just documented.
- [ ] `blockTimestamp` is taken from the log and normalised, with a test covering the decimal-vs-hex discrepancy.
- [ ] Reverting past a block removes its row, so a hash that has been reorged out stops resolving.
- [ ] Tests run against real local SQLite/libSQL in the repo's vitest style.

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
