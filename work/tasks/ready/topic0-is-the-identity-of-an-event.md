---
title: 'topic0 is the identity of an event, in the decoder and in the handler types'
slug: topic0-is-the-identity-of-an-event
spec: an-upgraded-contract-is-indexable-from-its-first-block
blockedBy: []
covers: [3, 4, 5, 6, 7, 8]
---

## What to build

Make an event's identity its **topic0** everywhere the indexer decides whether two ABI entries are the same event, and make the handler types tell the truth when they are not.

Today `deleteDuplicateEvents` keys on event NAME. Three consequences, all wrong:

- `Transfer(address,address,uint256)` and `Transfer(address,address,uint256,bytes)` are treated as duplicates, though they have different topic0s and are trivially distinguishable on the wire. So a contract whose upgrade CHANGED an event signature cannot be indexed with one source.
- The two call sites disagree. The per-address merge throws `two events with same name but different inputs`; the global list passes `false` and **silently splices the second one out**. Which one you get depends on `parseAllEventsIrrespectiveOfAddresses`.
- The silent case is the dangerous one: the dropped event's topic0 never enters the fetch filter, so those logs are never requested, and afterwards nothing distinguishes "the chain had none" from "we never asked".

Replace the name-keying with topic0-keying, and collapse the two verdicts into one rule applied on both paths:

- same topic0, deep-equal inputs: a true duplicate (the ordinary "two contracts share an event" case), keep one;
- same topic0, different inputs: a genuine collision, **refuse at construction**, naming the colliding events;
- different topic0: never duplicates, whatever their names.

The `failOnIdenticalNameButDifferentInputs` parameter goes away with the name-keying that motivated it.

Then stop the handler types lying, in **both** authoring surfaces (`@etherfold/js-processor` and `@etherfold/processor-entities` each hold their own copy of `InputValues`). `InputValues` is a mapped type over `InputNames<T>` with `T` used whole, so it does not distribute: an ABI with two `Transfer`s produces ONE `onTransfer` whose `args` is the two input lists MERGED, with the v2-only field **required**. A v1 log hands the author `undefined` through a type promising a hex string.

The fix is one line per copy, and this exact shape was compiled and checked before the task was written:

```ts
export type InputValues<T extends AbiEvent> = T extends AbiEvent
	? {[Property in InputNames<T>]: AbiParameterToPrimitiveType<Extract<T['inputs'][number], {name: Property}>>}
	: never;
```

`args` then becomes a union the author narrows with `'memo' in event.args`, and the single-version case is unchanged.

Handler keys stay NAME-based. A signature-keyed form applied only on conflict is expressible but needs a type-level canonical-signature formatter abitype does not provide, and it can be added later as an alias without removing the union. Do not build it here.

## Acceptance criteria

- [ ] Two ABI entries at one address whose events share a NAME but differ in inputs are ACCEPTED, and both topic0s appear in what the fetcher requests.
- [ ] Two entries with the SAME topic0 and different inputs are refused at construction, with a message naming the colliding events.
- [ ] Two entries with the same topic0 and deep-equal inputs are de-duplicated without error (the pre-existing "two contracts share an event" case still works).
- [ ] The verdict is IDENTICAL with and without `parseAllEventsIrrespectiveOfAddresses`: no ABI is accepted on one path and refused on the other, and none is silently truncated on either.
- [ ] No event that survives construction is missing from the fetch filter. Asserted against the requested topics, since that is where the silent drop was invisible.
- [ ] A log of each version at one address decodes to its own argument shape across an upgrade, driven through a captured stream in the style of `packages/browser/browser/workload.ts`.
- [ ] `InputValues` distributes in BOTH `@etherfold/js-processor` and `@etherfold/processor-entities`.
- [ ] `pnpm typecheck` asserts both directions with `@ts-expect-error`, in the style of `packages/browser/test/processorKinds.test.ts`: reading a version-specific field WITHOUT narrowing must not compile, and an ordinary single-version processor must compile exactly as before.
- [ ] Tests cover the new behaviour in the repo's vitest style, in the relevant packages' `test/` folders.
- [ ] A changeset covers every package whose public API or behaviour changed (at minimum the core, and both processor packages for the type change).

## Blocked by

- None — can start immediately.

## Prompt

> Make an event's identity its **topic0** rather than its name, in the `etherfold` monorepo, and make the `on<Event>` handler types honest when one name covers two wire events.
>
> FIRST, check this task against current reality. Its measurements were taken during a design conversation and are a snapshot: re-run them rather than trusting them. Specifically, confirm that (a) two entries at one address still merge their ABIs into a union, (b) a same-name-different-inputs ABI still throws `two events with same name but different inputs` on the per-address path and is silently spliced on the global path, and (c) `InputValues` still merges the two input lists with the v2-only field REQUIRED. If any of that has changed, route to needs-attention rather than building on the stale premise.
>
> Context and vocabulary. `CONTEXT.md` is the glossary. The decoding seam is `LogEventFetcher` in `@etherfold/core` (`internal/decoding/`), which builds a per-address ABI map, a global event list and the topic list used for `eth_getLogs`; decoding itself is viem's `decodeEventLog`, which already matches on topic0, so the RUNTIME decoder is not the problem — the admission gate and the types are. The two authoring surfaces are `JSProcessor` (`@etherfold/js-processor`) and `EntityProcessor` (`@etherfold/processor-entities`); each defines its OWN `InputValues`, so both need the change.
>
> Build two halves. (1) Re-key `deleteDuplicateEvents` on topic0 and apply ONE rule on both call sites: identical topic0 with deep-equal inputs is a duplicate, identical topic0 with different inputs is refused at construction naming both, different topic0s are never duplicates. Delete the `failOnIdenticalNameButDifferentInputs` parameter along with the name-keying that motivated it. (2) Make `InputValues` distribute (`T extends AbiEvent ? {...} : never`) in both packages, so a name covering two events yields a UNION the author must narrow.
>
> The failure this exists to prevent is the SILENT one, so test it where it was invisible: assert on the topics the fetcher REQUESTS, not only on what it accepts. A dropped event produced no error, no log and no fetch, and "no logs found" was indistinguishable from "we never asked".
>
> Assert the type claims through `pnpm typecheck`, not vitest — vitest strips types with esbuild without checking them (see the note in `CONTEXT.md` on what typechecks a test file). `packages/browser/test/processorKinds.test.ts` is the prior art: an `@ts-expect-error` FAILS the typecheck if the line it guards starts compiling, which is the only way to assert something is NOT accepted. Assert both directions — the un-narrowed read must not compile, and an ordinary single-version processor must still compile unchanged, because the whole point is that the common case pays nothing.
>
> Do NOT add signature-keyed handler names (`on['Transfer(address,address,uint256,bytes)']`). It is a deliberate deferral recorded in the spec: it needs a type-level canonical signature formatter abitype does not give you, and it can be added later as an alias without removing the union.
>
> Add a changeset covering every package whose public API or behaviour changed. Record any non-obvious in-scope decision in a `## Decisions` block in your final report, and do not commit without confirmation.
