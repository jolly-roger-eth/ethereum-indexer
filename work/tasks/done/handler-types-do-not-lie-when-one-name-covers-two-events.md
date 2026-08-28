---
title: 'Handler types do not lie when one event name covers two wire events'
slug: handler-types-do-not-lie-when-one-name-covers-two-events
spec: an-upgraded-contract-is-indexable-from-its-first-block
blockedBy: []
covers: [8, 9]
needsAnswers: true
---

## What to build

`abi-versions-are-block-ranged` fixes the DECODER for an upgrade that changed an event's signature. This fixes the AUTHORING surface, which the ranged buckets do not touch: the author still writes one `onTransfer` and still has to handle two payload shapes.

`InputValues` is a mapped type over `InputNames<T>` with `T` used whole, so it does not distribute over a union. Measured against an ABI carrying two `Transfer`s:

- `ExtractAbiEventNames<ABI>` collapses to `'Transfer'`, so `keyof EventFunctions` is exactly `'onTransfer'`. One handler for two wire events, which is fine.
- `InputValues<ExtractAbiEvent<ABI, 'Transfer'>>` **merges** the two input lists into `{from, to, id, memo}`, with `memo` **required**. This compiles today, and should not:

```ts
const memo: `0x${string}` = event.args.memo; // undefined at run time for a v1 log
```

Make it distribute. This exact shape was compiled and checked before the task was written:

```ts
export type InputValues<T extends AbiEvent> = T extends AbiEvent
	? {[Property in InputNames<T>]: AbiParameterToPrimitiveType<Extract<T['inputs'][number], {name: Property}>>}
	: never;
```

`args` then becomes a union the author narrows with `'memo' in event.args`, and the single-version case is byte-identical in behaviour.

**Both authoring surfaces hold their own copy** and both must change: `@etherfold/js-processor` and `@etherfold/processor-entities` each define `InputValues` and `InputNames`.

Handler keys stay NAME-based. A signature-keyed form applied only on conflict (`on['Transfer(address,address,uint256,bytes)']`, detected with an `IsUnion` check) is expressible but needs a type-level canonical signature formatter abitype does not provide: `FormatAbiItem` yields `"event Transfer(address indexed from, ...)"`, not the selector form. It can be added later as an ALIAS without removing the union, so do not build it here.

## Acceptance criteria

- [ ] `InputValues` distributes in BOTH `@etherfold/js-processor` and `@etherfold/processor-entities`.
- [ ] With an ABI carrying two same-named events, reading a version-specific field WITHOUT narrowing does not compile.
- [ ] Narrowing with `in` gives access to the version-specific field and to the shared ones.
- [ ] An ordinary single-version processor compiles exactly as before, on both surfaces. This is the criterion that stops the fix costing the common case anything.
- [ ] The assertions run under `pnpm typecheck` via `@ts-expect-error`, in the style of `packages/browser/test/processorKinds.test.ts`, whose `@ts-expect-error` lines fail the typecheck if the line they guard starts compiling.
- [ ] A changeset covers both packages.

## Blocked by

- None — can start immediately. Independent of `abi-versions-are-block-ranged`, but ship both before telling anyone a changed signature is supported: this one alone types a case the decoder still refuses, and that one alone decodes a case the types describe wrongly.

## Prompt

> Stop the `on<Event>` handler types lying when one event name covers two wire events, in the `etherfold` monorepo.
>
> FIRST, check this against current reality. The claim is that `InputValues` MERGES the input lists of two same-named events into one object with the version-specific field REQUIRED, rather than producing a union. Verify it before fixing it: build an ABI with `Transfer(address,address,uint256)` and `Transfer(address,address,uint256,bytes)`, and confirm that reading `event.args.memo` compiles. If it no longer does, route to needs-attention.
>
> The fix is one line per copy: make `InputValues` distributive (`T extends AbiEvent ? {...} : never`). Both `@etherfold/js-processor` and `@etherfold/processor-entities` define their own `InputValues` and `InputNames`; change both, since an author on either surface meets the same lie.
>
> Assert it under `pnpm typecheck`, NOT vitest, which strips types with esbuild without checking them (see the note in `CONTEXT.md` on what typechecks a test file). `packages/browser/test/processorKinds.test.ts` is the prior art: an `@ts-expect-error` FAILS the typecheck if the line it guards starts compiling, which is the only way to assert something is NOT accepted.
>
> Assert BOTH directions. The un-narrowed read must not compile, AND an ordinary single-version processor must compile exactly as before on both surfaces. The second is the one that matters for adoption: the whole justification for this shape over a bigger redesign is that the common case pays nothing, so prove it rather than assuming it.
>
> Do NOT add signature-keyed handler names (`on['Transfer(address,address,uint256,bytes)']`). It is a deliberate deferral recorded in the spec: it needs a type-level canonical signature formatter abitype does not give you, and it can be added later as an alias without removing the union.
>
> Add a changeset covering both packages. Record any non-obvious in-scope decision in a `## Decisions` block in your final report, and do not commit without confirmation.

## Decisions

- **Both packages bump `minor`, not `patch`.** The change can newly REFUSE code that compiled yesterday (an author who wrote `event.args.memo` against a two-version ABI), so it is not a silent fix; but the only code it refuses was already reading `undefined` through a lying type, and the single-version case is byte-identical, so it is not a `major` either. Alternatives considered: `patch` (understates a compile-time refusal a consumer meets on upgrade) and `major` (overstates it for the 0.x line, and would force every dependent through a rename-scale release). Touches: the release surface of `@etherfold/js-processor` and `@etherfold/processor-entities`, and via `updateInternalDependencies: patch` their dependents (`@etherfold/processor-sqlite`, which re-exports these types and holds no copy of its own, `@etherfold/browser`, `@etherfold/cli`).
- **Each test file carries a vitest half that drives a two-version processor with hand-made log events.** A reviewer could reasonably ask how that runs at all, given the fetcher still refuses two same-named events (`deleteDuplicateEvents`, keyed on NAME, the subject of `abi-versions-are-block-ranged`). It runs because both suites feed `process()` a stream directly, exactly as `reorg.test.ts` and `entity-event-processor.test.ts` do, so the source-level refusal is never reached. The value is that it proves the `in` narrowing the types now FORCE is also the branch a v1 payload actually takes at run time, rather than a compile-time story with no witness. Alternative considered: typecheck-only files with no vitest body, which is closer to the pure form of `processorKinds.test.ts`'s refusal block, but that block also sits in a file whose other half runs. Touches nothing outside these two test files; it does not assert anything about the fetcher, and it does not pre-empt `abi-versions-are-block-ranged`.
- **Observation captured, not fixed**: on a fresh clone, `pnpm typecheck` fails in `examples/web-demo` (`Cannot find module 'event-processor-bleeps'`, 11 svelte-check errors) until `pnpm build:examples` has run once, because `examples/*` are in the root `typecheck` filter but in neither the root `build` filter nor `verify`. Unrelated to this task and repo-wide, so it went to `work/notes/observations/examples-typecheck-needs-examples-built-first.md` rather than into this change.
