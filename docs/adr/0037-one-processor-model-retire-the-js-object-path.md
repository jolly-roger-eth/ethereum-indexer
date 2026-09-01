# One processor model: retire the JS-object path

The repo has carried two ways to author a processor: the free-form **JS-object** path (`fromJSProcessor`, state as an in-memory object persisted as a whole blob through `KeepState`) and the **ENTITY** path (declarations plus handlers over a `MutationContext`, state as versioned rows behind the `StateStore` seam). We are deleting the first. The entity path is what the project is for, and carrying both forks every seam that touches state.

## Why the JS-object path loses

- **It cannot serve a server, which is where the product is going.** It runs there — it is an `EventProcessor` — but it delivers none of what a server is for: no as-of queries, no retention or pruning, no bounded listing, and no SCHEMA for the GraphQL layer, which is generated from entity declarations. Its state is also a whole blob rewritten per save, the same shape this repo removed from the stream.
- **What it uniquely offers is an authoring STYLE**, not a capability. Its storage characteristic — a plain object with history as immer reverse patches — already exists behind the proper seam as `@etherfold/state-store-patch` (the LIGHT store), whose own source notes it is "the same arrangement as `@etherfold/js-processor`'s `processor/immer.ts`".
- **Two models cost more than they look**: two `ProcessorKind`s in `createIndexerState`, the `KeepState` blob-keeper family beside the `StateStore` seam, a second revert mechanism, and a second answer to every storage question.

## Consequences

- **Ordering is load-bearing.** `etherfold index` today REFUSES a processor without `keepState`, so the CLI is built around the path being deleted. `index-to-a-store-from-the-cli` must land first; the removal task is `blockedBy` it.
- **The stratagems conformance workload survives, minus one capability.** Kept: the contracts deployment as a real-ABI reference, the captured stream fixture as the golden INPUT, and the committed golden state as what the ported entity processor is compared against. Lost: the ability to REGENERATE that golden, since the oracle drives the vendored original through `fromJSProcessor`. The golden becomes a frozen expectation rather than a recomputable oracle — acceptable because `CONTEXT.md` already treats a diff on it as "a FINDING and not a fixture update", so regeneration was never the normal path.
- **`KeepState` is not automatically deleted with it.** It serves two masters: the JS-object blob AND the snapshot hydration path (ADR-0028). Only the first goes; what the snapshot path needs is kept, and the removal task carries that as its central judgement.
- **Six example apps use `fromJSProcessor`** and must be ported to entity declarations or deleted. Porting at least one is worth more than porting all six, because the examples exist to demonstrate the target path.
- **This does not deprecate `@etherfold/state-store-patch`.** An application that wants blob-like storage keeps it, behind the seam, with the capability reporting and conformance coverage the seam provides.

Relates to ADR-0002 (in-browser indexing stays primary — the entity path serves it via IndexedDB) and ADR-0016 (a processor package names where its state lives, which the entity path expresses through its store rather than through a keeper).
