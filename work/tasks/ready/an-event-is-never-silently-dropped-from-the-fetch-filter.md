---
title: 'An event is never silently dropped from the fetch filter'
slug: an-event-is-never-silently-dropped-from-the-fetch-filter
spec: an-upgraded-contract-is-indexable-from-its-first-block
blockedBy: []
covers: [11, 12]
---

## What to build

A standalone defect, found while investigating the upgrade question but independent of it: it needs no upgrade and no ABI versioning to reach.

`deleteDuplicateEvents` takes a `failOnIdenticalNameButDifferentInputs` flag, and the two call sites pass different values for the same ABI:

- the per-address merge passes `true`, and THROWS `two events with same name but different inputs`;
- the global event list passes `false`, and **silently splices the second event out**.

So the same ABI is refused or quietly truncated depending on whether `parseAllEventsIrrespectiveOfAddresses` is set. A parse-config flag decides which events exist.

The silent branch is the dangerous one: the dropped event's topic0 never enters the topic list, so its logs are never requested. Afterwards nothing distinguishes "the chain had none" from "we never asked", and no error, log or metric was produced at any point.

Make the two paths reach the SAME verdict on the same ABI, and make sure no event that survives construction is missing from what the fetcher requests. A genuinely ambiguous ABI must be refused loudly on both paths; an unambiguous one must be accepted on both.

Note the relationship to the sibling tasks, and do not overreach into them. Under `abi-versions-are-block-ranged`, two versions of one event are never in the same bucket, so version conflicts stop arriving here at all. What remains for this task is the case that has nothing to do with upgrades: **two different contracts in one source declaring an event of the same name with different inputs**, within the same range. That is legal, distinguishable on the wire by topic0, and currently either throws or is silently truncated depending on a flag.

## Acceptance criteria

- [ ] The accept/refuse verdict is IDENTICAL with and without `parseAllEventsIrrespectiveOfAddresses`, for every ABI.
- [ ] No event that survives construction is absent from the topics the fetcher REQUESTS. Asserted against the request, since that is where the failure was invisible.
- [ ] Two contracts declaring same-named events with different inputs are handled by one rule, and whichever it is (accept both, or refuse) it is the same on both paths and it is loud.
- [ ] A genuinely ambiguous ABI is refused at construction with a message naming the events involved, rather than truncated.
- [ ] The existing legitimate case still works: two contracts sharing an IDENTICAL event are de-duplicated without error.
- [ ] Tests cover the new behaviour in the repo's vitest style, including a regression test for the silent-drop path specifically.
- [ ] A changeset covers the behaviour change.

## Blocked by

- None — can start immediately. Independent of the other two tasks; if `abi-versions-are-block-ranged` lands first, this task's scope narrows to the multi-contract case but does not disappear.

## Prompt

> Stop an event being silently dropped from the fetch filter, in the `etherfold` monorepo.
>
> FIRST, verify the defect still exists. `deleteDuplicateEvents` in `LogEventFetcher` (`packages/core/src/internal/decoding/`) takes a `failOnIdenticalNameButDifferentInputs` flag; confirm that the per-address merge passes `true` and throws, while the global list passes `false` and splices the event out with no error, and that the spliced event's topic0 consequently never reaches the requested topics. If it no longer reproduces, route to needs-attention.
>
> The failure this exists to prevent is the SILENT one, so test it where it was invisible: assert on the topics the fetcher REQUESTS, not on what it accepts. A dropped event produced no error, no log and no fetch, and "no logs found" was indistinguishable from "we never asked". That is the same failure class as the `absence`-vs-`contradiction` distinction in the reorg model and as `SuspectedTruncationError`: an absence inferred from a request that was never made.
>
> One rule, both paths. Whether the right verdict is "accept both, since different inputs mean a different topic0 and they are distinguishable on the wire" or "refuse, naming them", it must not depend on `parseAllEventsIrrespectiveOfAddresses`. Decide it, record WHY in your `## Decisions` block, and make both call sites agree.
>
> Scope. This is about two DIFFERENT CONTRACTS in one source declaring same-named events with different inputs, within one block range. It is NOT about two versions of one contract's event across an upgrade: `work/tasks/ready/abi-versions-are-block-ranged.md` keeps those in separate per-range buckets so they never meet here. Read that task before starting so you do not solve its problem twice or build something it contradicts. Keep the legitimate de-duplication working: two contracts sharing an identical event must still collapse to one without error.
>
> Add a changeset for the behaviour change. Record any non-obvious in-scope decision in a `## Decisions` block in your final report, and do not commit without confirmation.
