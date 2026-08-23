---
'@etherfold/state-store-sqlite': minor
---

State can now be read as of a block **hash**, a **height** or a **timestamp**.

`getAsOf` and `queryAsOf` take a `BlockAddress` (`101`, `{number}`, `{hash}` or `{timestamp}`) where they took a block number. All three axes resolve to a block number through the canonical `_blocks` table this package already writes, and then run the same as-of predicate, so they answer identically when they identify the same block. Widening a parameter, so existing calls by number are unaffected.

- **Hash is the identifier a consumer should store.** Pinning a height means a reorg silently changes what "state at 18,000,123" refers to; pinning the hash makes the lookup answer "no such block", which is itself the signal that whatever was derived from it is invalid.
- **"No such block" is a distinct answer from "block known, entity absent."** An address that resolves to no block throws `NoSuchBlockError` (with a `reason` of `unknown-hash` or `no-recorded-block-at-or-before`), while `undefined` keeps its ordinary meaning. `resolveBlockNumber(address)` is the soft form, answering `undefined` and throwing nothing, and `getBlock(address)` returns the recorded row so a consumer can turn a time or a height into the hash to pin. See `docs/adr/0015`.
- **A timestamp resolves to the latest recorded block at or before T**, and to nothing before the first recorded block, never to the first block. Ties are broken by the highest block number.
- **Rows exist only for blocks that carry our logs**, which is the caller's judgement: every block handed to `applyBlock` is recorded, including one with no mutations, since a block can carry a log of ours that changes nothing and a consumer can legitimately pin its hash. A height needs no row and stays readable regardless; a hash needs one.
- `normalizeBlockTimestamp` reads `blockTimestamp` off a log in either encoding clients return (0x-prefixed hex per the spec, or decimal), and refuses anything else rather than defaulting to 0. Block hashes are folded to lower case on write and on lookup, so an echoed-back upper-case hash cannot masquerade as a reorg.
