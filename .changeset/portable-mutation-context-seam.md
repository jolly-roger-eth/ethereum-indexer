---
'@etherfold/state-store': minor
'@etherfold/processor-entities': minor
'@etherfold/state-store-sqlite': minor
'@etherfold/processor-sqlite': minor
---

Lift the processor authoring API out of the SQLite packages, so one processor runs against several storage backends.

Two new packages. **`@etherfold/state-store`** is the seam: entity declarations, `MutationContext` (now including `update` as sugar over get-then-spread-then-set), the `StateStore` interface a backend implements (`migrate` / `applyBlock` / `getCurrent` / `getAsOf` / `revertTo`), the capabilities it declares, and `MemoryStateStore`, a reference implementation in versioned rows over a Map. It declares no dependencies at all, which is what lets a storage primitive depend on it. **`@etherfold/processor-entities`** is the ABI-typed authoring surface (`EntityProcessor`, the `on<EventName>` handler map) plus the revert-then-apply engine (`applyEventStream`), written once against `StateStore` rather than per backend. ADR-0018 records why this is two packages and not one.

A backend now **reports what it can do as data**, readable before `migrate` and before any read: a retention kind (`revert-only`, a window of N BLOCK NUMBERS, or `unbounded`) and whether it answers as-of reads. `@etherfold/state-store-sqlite` reports `unbounded` because that is what is true of it: the package has no pruning, and it deliberately takes no retention option, since a store that accepted a window it cannot enforce would be making exactly the claim the report exists to prevent.

**`@etherfold/state-store-sqlite`** implements `StateStore` nominally, which it already did structurally: only `capabilities` was added. Its entity, mutation and block-pointer vocabulary is now defined at the seam and re-exported from here, so there is one definition rather than two; `ColumnType` is a deprecated alias of `FieldType`. Its block addressing (`getBlock`, hash and timestamp axes, `NoSuchBlockError`) and its SQL query surface (`queryCurrent` / `queryAsOf`) are unchanged and stay backend-specific on purpose.

**`@etherfold/processor-sqlite`** consumes the authoring types rather than defining them. `SQLProcessor` is kept as a deprecated alias of `EntityProcessor`, so existing processors compile unchanged; the type never had anything SQL in it.

The claim is asserted, not stated: `processor-entities/test/two-backends.test.ts` runs one processor, unmodified, against a real libSQL database and against the in-memory store, with the same declarations and the same handlers, and pins that the resulting state is identical, that read-your-writes composes two events in one block, and that a reorg makes a counter go back down on both.
