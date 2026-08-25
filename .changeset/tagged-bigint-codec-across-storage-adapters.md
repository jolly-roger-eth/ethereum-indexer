---
'@etherfold/core': minor
'@etherfold/browser': minor
'etherfold': minor
'@etherfold/fs': minor
---

**One BigInt convention, and it identifies a BigInt instead of guessing at one.** Every storage adapter now tags: `{"__bigint__": "123"}`, the codec the wire and the sync cursor already used. **`bnReplacer`, `bnReviver` and `isBigIntLiteral` are removed from `@etherfold/core`**, and `bnReviver` is removed from `@etherfold/browser`.

`"123n"` was both what `123n` serializes to and a perfectly legal string for a contract to emit, so the decoder could not tell them apart and silently changed the type of whichever it got wrong. That is silent in both directions: a real BigInt read back as a string breaks arithmetic downstream, a string read back as a BigInt breaks comparisons (including `===` against a hash) and JSON round-trips. It is not hypothetical, and both kinds genuinely coexist in one payload: `LastSync.unconfirmedBlocks` carries decoded `LogEvent`s whose `args` hold a BigInt per `uint256`, and the same document carries the `context` digests. `535ccc1` stopped that decoder THROWING on values that were never numbers and gave `simple_hash` a leading `h`; both were containment, and the guess itself is what this removes.

Moved onto the tag: **`etherfold`**'s snapshot keeper, **`@etherfold/browser`**'s `keepStateOnIndexedDB` and `keepStateOnLocalStorage`, **`@etherfold/fs`**'s file keeper, and `@etherfold/core`'s captured stream fixture. `@etherfold/processor-entities` was already on it.

**The legacy suffix form is not read, anywhere, and there is no fallback.** Translating it would be the same guess under a new name, and refusing every string of digits ending in `n` would refuse legitimate event data, so a `"123n"` string is now simply a string. Where a persisted artifact carries a FORMAT number the number was bumped instead, so a file written under the old convention is refused AS A FILE rather than half-decoded:

- **`STREAM_FIXTURE_FORMAT` is 2.** `parseStreamFixture` refuses a format-1 fixture, naming the file.
- **`etherfold`'s `SNAPSHOT_FORMAT` is 2, and older snapshots are no longer read.** A snapshot at format 1, or in the bare pre-envelope form, is logged and treated as absent, which cold starts. That is deliberate: its BigInts cannot be recovered by this reader, so resuming from it would resume from state whose every `uint256` had become a string, and re-indexing is the existing recovery for a snapshot that cannot be read. Delete the snapshot folder, or re-index once.
- The two artifacts with no format number of their own -- `@etherfold/fs`'s keeper blob and `keepStateOnLocalStorage`'s -- are caches whose recovery is a re-index, so a stale one reads back with its BigInts as the `"123n"` strings they now are. Call `clear()`, or clear site data.

`keepStateOnIndexedDB` needed the codec only on its REMOTE reads: the local half hands the object to `idb-keyval`, and IndexedDB's structured clone stores a BigInt as a BigInt.

The `"123n"` rendering survives in exactly one place, `simple_hash`, which uses it to have bytes to hash. Nothing decodes those bytes, so there is no guess to make, and changing it would change every digest ever persisted.
