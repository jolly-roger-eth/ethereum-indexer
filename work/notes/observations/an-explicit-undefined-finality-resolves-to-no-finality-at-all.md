---
title: '`resolveStreamConfig({finality: undefined})` returns a config with NO finality, so an explicit `undefined` is not the same as leaving the key out'
slug: an-explicit-undefined-finality-resolves-to-no-finality-at-all
observed: 2026-09-03
source: 'noticed while building task:a-reconfigure-hashes-the-resolved-stream-config-everywhere, enumerating the configs that must hash alike'
---

`resolveStreamConfig` is `{finality: 17, ...(stream || {})}` (`packages/core/src/internal/engine/utils.ts`), so a caller passing `{finality: undefined}` SPREADS the key back over the default and gets `{finality: undefined}`: `indexer.finalityDepth` becomes `undefined` (the reorg-window arithmetic in `getFromBlock` then runs on `NaN`), and the config hash is `simple_hash({})` rather than the default's, so it also reads as a different stream config from every other spelling of the default. Everywhere else in this codebase an explicit `undefined` and an absent key are deliberately one value (`canonical_form` drops `undefined`, pinned by `packages/core/test/hash.test.ts`), which is exactly the shape a JSON round-trip or an options object built with `{finality: opts.finality}` produces.
