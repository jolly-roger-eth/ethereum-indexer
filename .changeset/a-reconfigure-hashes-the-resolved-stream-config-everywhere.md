---
'@etherfold/core': patch
---

A reconfigure that changed nothing no longer re-indexes: the stream config is RESOLVED before it is hashed, everywhere.

The stream-config hash meant two different things. `reinit` stored the digest of the config `resolveStreamConfig` had filled in, so the persisted `context.config` always carried `finality`; `updateIndexer` digested the config exactly as the caller PASSED it. A caller who left `finality` unset — which is the ordinary case, and the whole reason the resolver exists — therefore produced a hash that could never match the stored one, whatever else that reconfigure changed or did not change. `sourceInvalidationOf` reported `reason: 'stream-config'`, which invalidates the STREAM half from block 0 as well as the state half, so the fold was discarded and, with no stream cache to rebuild from, the entire history was re-fetched from the node.

The resolve-then-hash step is now ONE function, **`streamConfigHashOf(stream)`**, exported from `@etherfold/core` beside `resolveStreamConfig` and for the same reason: a caller that builds a `ContextIdentifier` or a `WireContext` of its own has to reach the same digest the engine stored, and hashing the config a user passed instead of the config that runs is exactly how that goes wrong. Every site in the package goes through it — both verbs of the indexer, `wireContextOf`, and `captureStream`, which had the same defect and would write a fixture cursor no indexer running the default `finality` could match. A test asserts there is no second site in `packages/core/src` hashing a config.

**No digest moves and nothing is re-keyed.** `resolveStreamConfig` is idempotent, so a caller already holding a `UsedStreamConfig` (the wire identity) reaches the byte-identical digest it did before; `simple_hash` and the shared `canonical_form` are untouched; `streamDigestOf` already resolved and is unchanged. What a genuinely moved config does is unchanged too: `alwaysFetchTimestamps`, `alwaysFetchTransactions`, `parse.filters` and an explicitly different `finality` each still invalidate both halves from block 0. This removes a false positive, not the rule.
