# The storage seam is two packages, split on the dependency a store may not have

The processor authoring API is lifted out of the SQLite packages into **`@etherfold/state-store`** (the backend-neutral contract: entity declarations, `MutationContext`, the `StateStore` interface, declared capabilities, and an in-memory reference implementation) and **`@etherfold/processor-entities`** (the ABI-typed authoring surface: `EntityProcessor`, the `on<EventName>` handler map, and the revert-then-apply engine written against `StateStore`). One package would have been the obvious shape; it is two because a storage backend must be able to depend on the seam it implements, and the ABI-typed half cannot be depended on by a storage backend.

## Why not one package

Every candidate single package fails on the same edge. The handler map is typed off an ABI, so it needs `LogEvent` and the abitype helpers from `@etherfold/core`, and `@etherfold/core` depends on viem. If the entity declarations lived in the same package as the handler map, then `@etherfold/state-store-sqlite` — which must speak that vocabulary or duplicate it — would depend transitively on the entire indexer core.

That is not a packaging nit. ADR-0016 states the direction explicitly ("a processor package may depend on a store package, and not the reverse") and pins it with a test asserting what `state-store-sqlite` is allowed to import, precisely so the store stays a primitive. Inverting it would mean installing a versioned-row store pulls in viem.

The alternative to splitting was to leave `state-store-sqlite` with its own copy of `EntityDeclaration`, `Mutation` and `BlockPointer`, structurally compatible with the seam's and never nominally the same types. TypeScript's structural typing makes that work, and it is what was rejected: two definitions of the vocabulary that a seam exists to make singular, kept in step by nothing but attention, in the package a future backend will be written by copying.

Splitting keeps every definition singular. `@etherfold/state-store` declares **no dependencies at all**, which is what makes it safe for a storage primitive to depend on, and the leakage test now asserts that emptiness as well: the moment the seam takes a dependency, the store inherits it.

## Why these names

ADR-0014's rule is role first, backend last; ADR-0016 applies it to processors, where the trailing slot names **where the state lives**. Both new names read off that axis with the slot filled by something that is not an engine:

```
@etherfold/state-store            the state-store ROLE with no backend: the contract itself
@etherfold/state-store-sqlite     versioned rows over remote-sql
@etherfold/processor-entities     a processor whose state lives in declared entities, backend chosen at deployment
@etherfold/processor-sqlite       the same, with SQLite wired in and the sync cursor
@etherfold/processor-js           state in a JS object, reverted by immer patches
```

`entity-processor` and `processor-api` were rejected for breaking that ordering: a scope listing must keep the variants of one role adjacent.

## Consequences

- **`@etherfold/processor-sqlite` no longer defines an authoring API.** `MutationContext`, `EventHandlers` and the processor type are re-exported from `@etherfold/processor-entities`, and `SQLProcessor` survives as a deprecated alias of `EntityProcessor` (the type never had anything SQL in it; the name predated the seam).
- **`@etherfold/state-store-sqlite` implements `StateStore` nominally**, which it already did structurally: `migrate` / `applyBlock` / `getCurrent` / `getAsOf` / `revertTo` matched the interface before the interface existed. Only `capabilities` was added. A seam that costs one getter to adopt is a seam in the right place.
- **The richer read surface stays backend-specific.** `queryCurrent` / `queryAsOf` take caller-supplied SQL and block addressing resolves hashes and timestamps; neither is at the seam, because a handler runs once per event on backends with no query planner. The bounded read the handler seam is genuinely missing is `bounded-id-prefix-listing`.
- **The capability report lands as shape only.** A store reports its retention and whether it answers as-of reads; nothing yet refuses an out-of-window read (`retention-capability-and-refusal`) and nothing yet prunes (`prune-versions-outside-retention-window`), so the SQLite store reports `unbounded` because that is what is true of it.
- **A third package would be needed for a memory backend under a literal reading of the naming rule** (`state-store-memory`). It is not created: `MemoryStateStore` ships inside the contract package, because a contract with no runnable implementation is a document rather than a specification, and this one exists to be the executable definition and the second backend a portability test needs. A production browser backend is a package of its own (`indexeddb-row-backend-browser-default`).
