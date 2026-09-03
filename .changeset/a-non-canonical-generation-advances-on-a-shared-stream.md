---
'@etherfold/core': minor
---

A non-canonical generation ACTUALLY ADVANCES, and HOW it advances is DETERMINED by whether it shares a stream — never configured.

An `Indexer` now advances EVERY generation it holds, not just the canonical one. `load()` loads all of them (a fold that never loaded has no state and no cursor to advance from) and `indexMore()` steps all of them, in the order they were built, each by the verb its stream decides. Which generation ANSWERS is still the canonical pointer's decision and nothing else's.

**A generation that SHARES a stream with one already held is a FOLLOWER: it fetches nothing at all.** It re-folds the stored stream from the start and then follows it as the indexing generation appends. Zero `eth_getLogs`, not fewer, and zero segments written. A generation naming its own `source` is on its own stream and is an ordinary indexer at a different address, fetching its own history into its own keyspace.

There is no flag for this and there must never be one (ADR-0044), because a flag would be wrong in both positions. "Follow a stream nobody writes" never advances. "Fetch a stream somebody else writes" is a second writer — and, worse, it makes that generation's state a function of ITS OWN FETCH rather than of the stream, so re-folding the stored stream later would yield a DIFFERENT state. A generation would stop being "a stream plus a fold over it", and the promise that moving the canonical pointer BACK restores answers exactly would go with it.

New and changed API:

- **`readOnlyStream(reader)`** (`@etherfold/core`) — an `ExistingStream` whose `saveNewEvents` and `clear` are no-ops. This is what makes the one-writer rule STRUCTURAL rather than a convention: read and write share one seam, and `promiseToSave` calls `saveNewEvents` unconditionally, so a pure reader is not expressible by declining to write. Only the generation that INDEXES a stream is handed the keeper; every other generation folding it is handed one of these. `clear` is a no-op for a sharper reason than symmetry — the load path clears on every stream shape it cannot use, and a follower takes those branches over a stream another generation is still indexing into. `replayStream` is now built out of it rather than being a second implementation of the same idea; its behaviour is unchanged.
- **`IndexerGeneration.followMore()`** — advance from the STORED STREAM alone, fetching nothing. The catch-up branch of `load` made repeatable: the first call re-folds the whole stored stream, every call after it replays what is new. Every branch that cannot proceed simply returns; a stream this generation does not own is not its to clear.
- **`GenerationSpec.source`** — the fetch filter THIS generation folds, when it is not the container's own. A stream IS its fetch filter, so this is the only way to say "a different stream", and saying it is what makes the follow-or-fetch rule determined. The stream CONFIG is deliberately not settable per generation: `setStreamConfig` is a single mutable value on the ONE keeper a container holds, so two generations under different configs would clobber each other's address.
- **`HeldGeneration.follows`** — whether a held generation follows a stream another one writes. Reported, never set.
- `Indexer.disableProcessing()` / `reenableProcessing()` now apply to every held generation rather than to the canonical one alone, which is the honest meaning now that every generation advances.
