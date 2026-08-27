---
'@etherfold/core': minor
'@etherfold/browser': minor
---

A reconfigure now REPORTS whether it discarded the state, and the browser hook stops publishing state the core has thrown away.

`updateProcessor`, `updateIndexer` and `reset` decide between two very different outcomes -- the computed state survives, or it is gone and being rebuilt -- and used to tell nobody. They now return `ReconfigureOutcome` (`{stateDiscarded: boolean}`). The widening is additive: a caller that ignored the resolved value still compiles and still behaves identically.

That silence was a live defect for any caller holding a COPY of the state, which is every UI. `onStateUpdated` fires when a state is ADOPTED or PRODUCED, and a discard is neither, so `createIndexerState(...).state` went on publishing the discarded state until the next event happened to arrive and overwrite it. On the free-form path that is the old state VALUE: stale numbers, rendered by every subscriber, looking exactly like a working app.

The wait was unbounded, and the case that makes it unbounded is the ordinary local-development one. These apps redeploy behind a proxy, so the address does not move and the regenerated ABI is what changes; the indexer correctly discards, correctly re-indexes, and correctly finds NOTHING, because a freshly redeployed implementation has not emitted anything yet. With no event to overwrite it, the tab showed state computed from the contract that is no longer deployed for the rest of the session. The same held for an edited processor swapped in under a bumped version, and for an explicit `reset()`.

The hook now re-seeds `$state` at the moment of the discard, and only then: a reconfigure that KEPT the state must not blank it, or saving a file that changed nothing would empty the UI. Both directions are pinned in `packages/browser/test/reconfigure.test.ts` and driven in Chromium, Firefox and WebKit in `packages/browser/browser/indexing.spec.ts`.

Note what did NOT change, because it is the trap an integrator meets first: a version hash is AUTHOR-DECLARED (`version`, the entity declarations, the config, and nothing derived from handler code). An edited handler under an unchanged `version` is not a change the core can see, so `updateProcessor` skips the swap and the edit never runs. Bump `version`, or pass `{force: true}`.
