---
title: '`updateIndexer` hashes the PROVIDED stream config while everything else hashes the RESOLVED one, so re-passing an unchanged config can force a full re-index'
slug: updateindexer-hashes-the-provided-stream-config-not-the-resolved-one
observed: 2026-09-02
source: 'noticed while building task:a-stream-is-identified-by-the-digest-of-its-filter, reading `packages/core/src/indexer.ts` for where a keeper could be handed the resolved stream config'
---

`reinit` sets `this.streamConfigHash = simple_hash(this.config.stream)` on the RESOLVED config (`resolveStreamConfig` fills `finality: 17`), but `updateIndexer` computes `newConfigHash = simple_hash(update.streamConfig)` on the config as PROVIDED (`packages/core/src/indexer.ts`, the constructor path around the `resolveStreamConfig` call and `updateIndexer`'s first lines). So calling `updateIndexer({streamConfig})` with the very same object passed at `init`, whenever it leaves `finality` unset, produces a different hash from the stored one, `sourceInvalidationOf` reports `reason: 'stream-config'`, and both halves are invalidated: the state is discarded and the stream re-fetched for a reconfigure that changed nothing.
