---
title: 'All three blob keepers write a `__VERSION__` marker that nothing in the workspace ever reads'
slug: keeper-version-marker-is-written-and-never-read
observed: 2026-08-25
source: 'noticed while driving task:tagged-bigint-codec-across-storage-adapters, migrating the keepers onto the tagged BigInt codec'
---

`keepStateOnFile` (`packages/fs/src/storage/state/OnFile.ts`), `keepStateOnIndexedDB` and `keepStateOnLocalStorage` (`packages/browser/src/storage/state/`) each save `{...all, __VERSION__: context.version}`. `grep -rn "__VERSION__"` across `packages`, `examples` and `platforms` returns those three WRITES and no read: `fetch` on all three hands the whole blob back and nothing inspects the field, so a processor version change does not make a stale blob detectable through it.

Noticed because these three are exactly the persisted artifacts that carry no format number, which is why the tagged-codec migration left them reading a legacy blob as strings rather than refusing it (ADR-0029). A marker that is already written and already ignored is a plausible place for that check to live, if anyone decides it should exist.
