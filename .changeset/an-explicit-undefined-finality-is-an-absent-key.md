---
'@etherfold/core': patch
---

`resolveStreamConfig` now treats an explicit `undefined` as an ABSENT KEY, so `{finality: undefined}` resolves to the default instead of to no finality at all.

Every field of a `ProvidedStreamConfig` is optional, so `{finality: undefined}` type-checks, and it is exactly what a JSON round-trip or an options object built as `{finality: opts.finality}` produces. The resolver spread it straight over the default, and the damage was silent on three axes at once: `finality` became `undefined`, so `getFromBlock`'s `latestBlock - finality` evaluated to `NaN` and poisoned the block the next round asked from; the config hashed as though no default applied; and it therefore read as a DIFFERENT stream config from every other spelling of the same default, which is a full re-index on a reconfigure that changed nothing.

The digest this feeds already collapses an explicit `undefined` to an absent key (`canonical_form`/`simple_hash`, pinned by `test/hash.test.ts` as "treats an explicit undefined as absent, exactly as JSON does"). The resolver disagreeing with the digest it feeds is what made the disagreement reachable, so the resolver is made to agree: any explicitly-undefined key is dropped before the default is applied, not just `finality`.

**One consequence worth stating.** A caller that passed `{finality: undefined}` now hashes as the default rather than as `{}`, so its stored stream and state are re-keyed once. That case was already broken — its reorg window was `NaN` — so this converts a silent corruption into a single re-index, and no working configuration moves: `undefined`, `{}`, `{finality: 17}` and `{finality: undefined}` are now one config and one digest. A real value still wins, including the falsy `finality: 0`.
