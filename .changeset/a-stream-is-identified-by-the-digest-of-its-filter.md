---
'@etherfold/core': minor
'@etherfold/browser': minor
---

A cached stream has a real IDENTITY: a digest of its FETCH FILTER plus its stream CONFIG, and that digest fills the address level `the-stream-appends-in-segments-on-indexeddb` left as a placeholder.

`@etherfold/core` exports `streamDigestOf(source, streamConfig)`: 128 bits of `viem`'s `sha256`, SYNCHRONOUS, rendered as 32 fixed-length lowercase hex characters every substrate can carry as a key element. It is taken over the DEDUPLICATED `streamHash` values SORTED BY THEMSELVES, plus the resolved stream config, and over nothing else. `hash` and `legacyHash` are excluded: they cover the DECODING shape, which is what the stream is deliberately independent of. Sorting the values by themselves rather than rolling the digest up over the entry list is load-bearing — that list is sorted by `(startBlock, hash)`, so a decode-only change (a renamed non-indexed parameter) reorders it while every `streamHash` is unchanged, and a digest over that order would fork a new stream, re-fetch the whole history and orphan the old one, silently.

`simple_hash`'s canonicalisation is extracted as `canonical_form` and shared rather than copied, so the wide digest and the 32-bit change detector cannot disagree about whether two values are the same; `simple_hash` itself is byte-for-byte unchanged.

The config is in the digest because it decides what a stream CONTAINS (`alwaysFetchTimestamps`, `alwaysFetchTransactions`, `parse.filters`), and because `sourceInvalidationOf` already invalidates the stream half from block 0 whenever it moves. This is ADR-0006's `{source, config}` stream keying made concrete, narrowed on the source side to the FETCH half per ADR-0034 (ADR-0008's 2026-08-31 amendment records the narrowing).

**`ExistingStream` gains an optional `setStreamConfig`**, which the indexer calls in `reinit` with the config it RESOLVED, before any other call and again on every reconfigure. A keeper is handed a `source` on every operation and never the config, so without it a keeper that addresses a stream would map two configs onto one subtree. A keeper that addresses nothing (a replayed fixture) omits it.

**`keepStreamOnIndexedDB` now addresses `['stream', <indexer-name>, <streamDigest>, ...]` with the real digest**, and `placeholderStreamDigest` is deleted. `streamAddress(name, source, streamConfig)` takes the source and the config in place of the `chainId` it used to derive the placeholder from; `chainId` is still not a level of its own, because the digest covers it through the block-0 skeleton entry. The `<indexer-name>` level is untouched, so two names and two chains stay isolated exactly as before.

**Nothing migrates and no payload is rewritten.** A stream written under the placeholder is simply a stream under a different digest: unreachable by a filter that now resolves elsewhere, so nothing needs to move. Disposing of those subtrees belongs to the unregistered-subtree sweep in the generation registry, which is the only place that can know which digests are registered.
