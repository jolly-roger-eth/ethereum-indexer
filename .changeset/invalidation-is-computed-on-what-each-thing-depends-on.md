---
'@etherfold/core': minor
'@etherfold/browser': patch
---

Invalidation is computed on what each thing actually depends on, instead of one hash over the whole source.

An ABI is REGENERATED, not hand-edited, so the members that move in it most often are the ones nothing depends on. Until now a source that declared no event block range hashed WHOLESALE into a single context entry, so any difference anywhere in it discarded the state and the cached event stream and re-fetched all history.

**What now costs nothing:**

- **adding a view function, an error or a constructor.** A non-event ABI member is not indexed, does not enter the fetch filter and cannot change what a log decodes to, so it contributes to no entry at all;
- **reordering the events** in the ABI array, which regeneration does routinely. The entry list is sorted into a canonical order rather than transcribed, so the persisted bytes are identical and not merely the verdict;
- **recompiling into a different `internalType`.** An entry is hashed on what DECODING reads, which deliberately excludes it.

The rest of the source is NOT free: `chainId`, `genesisHash`, a contract's `address` and a contract's `startBlock` still invalidate everything, exactly as before.

**The verdict is now TWO verdicts**, because the fetch and the fold do not depend on the same thing:

- the **stream** is raw logs fetched under a topic-and-address filter, so it survives anything that did not GROW that filter. A shrunken topic set leaves a strict SUPERSET, which is reusable by decoding less;
- the **state** is a fold over decoded events, so it must be recomputed whenever the decoding shape moved, even if not one log needs re-fetching.

A renamed non-indexed parameter is the case that proves it: `topic0` hashes types and not names, so the stream is KEPT and the state is DISCARDED, and the rebuild happens from the cache without going back to the node. Removing an event does the same. Both halves still name the block they are invalid from.

**A cached stream is decoded again on replay.** Its `args` and `eventName` are what some earlier ABI made of the raw log, so keeping a stream across a source change keeps the raw half and recomputes the rest, against the source running now. Where a `logValues` projection dropped `topics` or `data` there is nothing to re-read, and the stream is cleared rather than replayed on trust.

**Nothing to do on upgrade.** `ContextIdentifier` is persisted, and a context written by any earlier version is still read correctly: a per-range context matches byte for byte, and a whole-source context is compared against a bridge digest carried on the block-0 entry, so an unchanged source invalidates nothing. The first save afterwards rewrites the context in the new shape.

`ContextIdentifier.source` and `WireContext.source` are now typed as `SourceHashEntry[]`, which is the shape they already had plus two optional digests. `wireContextOf` is unchanged.
