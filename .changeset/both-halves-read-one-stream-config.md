---
'etherfold': patch
'@etherfold/fetcher-host': patch
---

`etherfold run` and `etherfold build` no longer refuse to start when `STREAM_FINALITY` is set, and every command now HONOURS the environment's stream settings instead of half-ignoring them.

The resolved stream config is hashed into the wire identity, so the sending `LogFetcher` and the receiving `StreamBuilder` must reach the same one. `resolveFetcherHostConfig` read three settings from the environment (`STREAM_FINALITY`, `STREAM_ALWAYS_FETCH_TIMESTAMPS`, `STREAM_ALWAYS_FETCH_TRANSACTIONS`) and then merged the caller's override OVER them. The commands that hold both halves in one process passed a hard-coded empty override, and spreading `{}` cannot remove a key the environment has already put there: the sender resolved `finality: 25` while the receiver resolved the default `17`, the digests could never match, and `WireContextMismatchError` is not retryable, so the process exited.

The split deployment failed the same way and worse, because there the operator is told the two halves must agree: `etherfold fetch` honoured `STREAM_FINALITY` while `etherfold index` was pinned to the default, so setting it on both hosts, which is what a careful operator does, made every push refused.

The stream config is now derived ONCE from the environment (`streamConfigFromEnv`, newly exported from `@etherfold/fetcher-host`) and handed to both halves, and an override REPLACES the environment's config rather than merging over it, because a spread can add a key but can never say "no finality here".

The fix deliberately keeps the variable working rather than making both halves ignore it. Agreeing by ignoring would have satisfied the digest comparison while silently discarding a documented setting, and this CLI's rule is that nothing is accepted and ignored. The combined shape and the split shape now read one environment the same way.

`STREAM_CONFIG`, previously exported from `etherfold`, is replaced by `streamConfigFor(env)`. It could not remain a constant: the value depends on the environment.
