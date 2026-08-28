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

> **RE-SCOPED 2026-08-28: this task GREW, and it now UNBLOCKS its sibling.** An earlier version
> said that `abi-versions-are-block-ranged` would keep two versions of one event in separate
> per-range buckets, so upgrade conflicts would never reach this code, leaving only the
> multi-contract case here. That is no longer true. The ranged model was rejected for decoding:
> there are no buckets and no block axis in `parse()`, so two versions of one event now land in
> the SAME ABI list and are told apart by topic0. This task is therefore what makes an upgrade
> possible at all, and `abi-versions-are-block-ranged` is now BLOCKED BY it rather than narrowing it.

Two cases now arrive here, and one rule must cover both:

- **Two versions of ONE contract's event across an upgrade.** `Transfer(address,address,uint256)`
  and `Transfer(address,address,uint256,bytes)` in one source. Different topic0s, trivially
  distinguishable on the wire, and at the upgrade block BOTH can legitimately occur, because the
  upgrade transaction sits mid-block and a transaction before it still fires the old event.
- **Two DIFFERENT contracts in one source declaring an event of the same name with different
  inputs**, the case that has nothing to do with upgrades.

Both are legal, both are distinguishable by topic0, and both currently either throw or are
silently truncated depending on a flag.

## Acceptance criteria

- [ ] The accept/refuse verdict is IDENTICAL with and without `parseAllEventsIrrespectiveOfAddresses`, for every ABI.
- [ ] No event that survives construction is absent from the topics the fetcher REQUESTS. Asserted against the request, since that is where the failure was invisible.
- [ ] Two contracts declaring same-named events with different inputs are handled by one rule, and whichever it is (accept both, or refuse) it is the same on both paths and it is loud.
- [ ] A genuinely ambiguous ABI is refused at construction with a message naming the events involved, rather than truncated.
- [ ] The existing legitimate case still works: two contracts sharing an IDENTICAL event are de-duplicated without error.
- [ ] Two VERSIONS of one contract's event (same name, different inputs, different topic0) are both kept, and both topic0s appear in what the fetcher requests. This is what `abi-versions-are-block-ranged` needs in order to exist.
- [ ] At a single block both versions can be requested together, since an upgrade transaction sits mid-block and a transaction before it still fires the old event.
- [ ] Tests cover the new behaviour in the repo's vitest style, including a regression test for the silent-drop path specifically.
- [ ] A changeset covers the behaviour change.

## Blocked by

- None — can start immediately, and it should go FIRST of the remaining work.
  `abi-versions-are-block-ranged` is blocked by it: with no per-range buckets, a source carrying
  two versions of one event cannot even be constructed until `deleteDuplicateEvents` stops keying
  on NAME, so that task cannot be built until this one lands.

## Prompt

> Stop an event being silently dropped from the fetch filter, in the `etherfold` monorepo.
>
> FIRST, verify the defect still exists. `deleteDuplicateEvents` in `LogEventFetcher` (`packages/core/src/internal/decoding/`) takes a `failOnIdenticalNameButDifferentInputs` flag; confirm that the per-address merge passes `true` and throws, while the global list passes `false` and splices the event out with no error, and that the spliced event's topic0 consequently never reaches the requested topics. If it no longer reproduces, route to needs-attention.
>
> The failure this exists to prevent is the SILENT one, so test it where it was invisible: assert on the topics the fetcher REQUESTS, not on what it accepts. A dropped event produced no error, no log and no fetch, and "no logs found" was indistinguishable from "we never asked". That is the same failure class as the `absence`-vs-`contradiction` distinction in the reorg model and as `SuspectedTruncationError`: an absence inferred from a request that was never made.
>
> One rule, both paths. Whether the right verdict is "accept both, since different inputs mean a different topic0 and they are distinguishable on the wire" or "refuse, naming them", it must not depend on `parseAllEventsIrrespectiveOfAddresses`. Decide it, record WHY in your `## Decisions` block, and make both call sites agree.
>
> Scope, and note it GREW on 2026-08-28. This covers BOTH two different contracts declaring
> same-named events with different inputs, AND two versions of one contract's event across an
> upgrade. An earlier version of this task excluded the upgrade case on the grounds that
> `abi-versions-are-block-ranged` would hold versions in separate per-range buckets; that model
> was rejected, there are no buckets, and both cases now reach this code as one flat ABI list told
> apart by topic0. Read `work/tasks/ready/abi-versions-are-block-ranged.md`, including its
> re-scope note, before starting: it is BLOCKED BY this task and cannot be built until you land.
> Keep the legitimate de-duplication working: two contracts sharing an IDENTICAL event must still
> collapse to one without error.
>
> Add a changeset for the behaviour change. Record any non-obvious in-scope decision in a `## Decisions` block in your final report, and do not commit without confirmation.

## Decisions

**Accept both events when their topic0s differ; refuse only a true topic0 collision.** The task left the verdict open between "accept both" and "refuse, naming them". I chose accept-both because topic0 is what a log carries: `Transfer(address,address,uint256)` and `Transfer(address,address,uint256,bytes)` are distinguishable on the wire with no ambiguity to resolve, and at an upgrade block both legitimately occur (the upgrade transaction sits mid-block). Refuse-both was the alternative, and it would make a contract that ever changed an event signature un-indexable at all, which is exactly what `abi-versions-are-block-ranged` needs to stop being true. Touches: `abi-versions-are-block-ranged` (this is its unblock), and the public behaviour of `LogEventFetcher` for anyone whose ABI previously lost an event. Recorded as ADR-0031.

**Declarations are compared on their DECODING shape, not with a whole-object equality.** The old per-address path used `deepEqual(event.inputs, ...)`, which includes `internalType`. Since the refusal now stops the indexer starting on both paths (where the global path previously just truncated), an `internalType` difference between two compilations of the genuinely same event would newly break a working deployment. So the comparison is on parameter names, types, `indexed` flags, tuple components and `anonymous`, with a missing parameter name normalised to `''`. Alternative considered: keep whole-object equality and accept the false refusals as "loud is safe" — rejected because a loud refusal that is wrong is still wrong, and `internalType` cannot change what a log decodes to. Touches: any source assembled from ABIs produced by different compilations. In ADR-0031.

**A name-keyed argument filter now applies to EVERY topic0 that name covers.** `LogParseConfig.filters` is documented as keyed by event name, and a name can now cover several topic0s. Previously `_nameToTopic` was last-write-wins, so one version got the filter and the other fell into the shared, unfiltered request — the same declared filter meaning two different things for two versions of one event. The alternative, filtering only one topic0, is not expressible as a user intent anyone would have written. Touches: `parseConfig.filters` (user-visible: with an upgrade pair, a configured filter now produces one request per version rather than one filtered plus one unfiltered). In ADR-0031's consequences.

**The refusal is a plain `Error`, not a new exported error class.** `packages/core/src/errors.ts` is an explicitly framed family about wire refusals and retryability (every member carries `retryable`), and this is a construction-time programming error, alongside the existing plain `duplicate topics found` throw in the same file. Alternative considered: an `AmbiguousEventABIError` in `errors.ts` — rejected as expanding the public error surface and re-meaning that family for something that never crosses the wire. The message carries what a caller needs (both declarations and the topic0), and the tests assert on it.
