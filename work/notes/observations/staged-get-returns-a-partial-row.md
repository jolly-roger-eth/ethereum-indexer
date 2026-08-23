---
title: '`MutationContext.get` answers with a PARTIAL row for a key staged in the same block'
slug: staged-get-returns-a-partial-row
observed: 2026-08-23
source: 'task:bounded-id-prefix-listing, while deciding what shape a listing row should have when it comes from the staging area'
---

`get` served from the store returns the whole row (the id columns, every declared field, and the version columns); `get` served from the block's staging area returns `{...staged.values}`, which is only what the handler passed to `set` (`packages/state-store/src/mutation-context.ts`). So `row.epoch` (an id column) and a declared field the write did not list are `undefined` for a row written earlier in the same block and present for one written in an earlier block, which is a shape difference that depends on timing.

Not fixed here and not known to bite: `update` strips to declared fields anyway, and `list` (added by this task) fills the id columns and the unlisted declared fields in for staged rows precisely so a listing's rows have ONE shape whatever they came from. Recorded because `get` and `list` now disagree about it, and because the failure mode is a handler reading a field that is only sometimes there.
