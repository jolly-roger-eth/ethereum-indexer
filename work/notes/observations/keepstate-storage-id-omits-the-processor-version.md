---
title: 'The js-object state keeper derives its storage key without the processor version, so two versions share a key'
slug: keepstate-storage-id-omits-the-processor-version
observed: 2026-08-29
source: 'noticed while auditing the a-reconfigure-is-not-an-outage spec against the code, checking whether the js-object path needs a per-generation keeper factory'
---

`KeepState` is `{fetch, save, clear}` and all three receive a `ProcessorContext`, which is
`{source, config?, version}`. So the keeper already has everything it needs to key storage per
processor version. It does not use it:

```ts
// packages/browser/src/storage/state/OnLocalStorage.ts
const storageID = getStorageID(name, context.source.chainId, 'config' in context ? context.config : undefined);
```

`name`, `chainId` and `config` are in the key. `version` is not. So a processor at `1.0.0` and the
same processor at `1.1.0` write to the SAME storage key.

**This is not currently a bug, and the reason it is not is worth writing down.** On load,
`indexerMatches` compares the stored `context.processor` hash and rejects state a different
processor version produced, so the stale blob is discarded rather than adopted. The key collision is
therefore transient and self-correcting: the wrong-version blob is read, refused, and overwritten.

Two reasons to record it anyway:

- The blob is written to a key that does not describe what is in it, so the storage layer's key is
  not an identity. Anything that later wants to hold TWO versions at once (see
  `work/specs/proposed/a-reconfigure-is-not-an-outage.md`) turns this transient overlap into a real
  one: two generations would collide on one key and the second would clobber the first, with the
  refusal-on-load no longer able to tell them apart because both are legitimately current.
- It costs a needless discard-and-re-index on every processor version bump for anyone whose state
  would otherwise still have been valid. That is bounded and probably correct today, but it is a
  cost paid by key design rather than by decision.

Not touched: outside the audit that found it. The fix is one term in `getStorageID`, but it changes
where existing state is found, so it needs the same migration care as any stored-format change.
