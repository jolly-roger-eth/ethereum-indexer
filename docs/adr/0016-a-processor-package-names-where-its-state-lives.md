# A processor package names where its state lives

A package implementing the `EventProcessor` contract is published as **`@ethereum-indexer/processor-<backend>`**, where the backend is where that processor keeps its state. The first is **`@ethereum-indexer/processor-sqlite`**, whose state is versioned rows in `@ethereum-indexer/state-store-sqlite`. The directory follows the leaf name, so `packages/processor-sqlite/`.

## Why this needed a decision rather than a reading

ADR-0014 settled the scope and gave storage packages the shape `<role>-store-<backend>`. It does not answer this case, and the gap is not cosmetic: a processor is not a store. `state-store-sqlite` is a storage primitive that knows nothing about Ethereum; a processor is a reducer over a log stream that happens to keep its state somewhere. Reading the scheme literally would produce `processor-store-sqlite`, which names the package after the thing it depends on rather than the thing it is.

What generalises from ADR-0014 is not the literal string but its stated ordering rule: **role first, backend last**, following `@sveltejs/adapter-node` and `@vitest/coverage-v8`, so that consumers pick a role and then a backend and variants of one role stay adjacent in a scope listing. The `-store-` in `state-store-sqlite` is part of the ROLE (`state-store`, one of the two stores ADR-0006 commits the server to), not a separator. Applying the same rule with the role `processor` gives `processor-sqlite`.

## Why the backend, and not what it does

The alternatives were named after the storage model rather than the engine: `versioned-state-processor`, `historical-processor`. They are rejected for the reason ADR-0014 already gives for naming the backend rather than abstracting to `sql`. This package depends concretely on `state-store-sqlite`, and per the design's §8 a Postgres store is a sibling implementation rather than a dialect flag, so a Postgres-backed processor would be a sibling package. A name claiming the storage model would have to be renamed the day that sibling exists, whereas `processor-postgres` sits beside `processor-sqlite` for free.

It also reads correctly against the package that already exists. `ethereum-indexer-js-processor` migrates under ADR-0014's expand/migrate/contract to `@ethereum-indexer/processor-js`, and the pair then states the actual distinction: same role, same contract, different place the state lives.

```
@ethereum-indexer/processor-js         state in a JS object, reverted by immer patches
@ethereum-indexer/processor-sqlite     state in versioned rows, reverted by revertTo
```

## Consequences

- **"Processor" keeps the meaning `CONTEXT.md` gives it**: the reducer contract, never a deployable. `processor-sqlite` is a library implementing `EventProcessor`, and the deployable that hosts one is still `@ethereum-indexer/server` (ADR-0003, ADR-0014).
- **The class inside is named for the storage model, not the backend.** `VersionedStateEventProcessor` sits beside `JSObjectEventProcessor`, because within a package the backend is already established by the package name, while the state model is the thing a reader needs told. That also leaves the class name usable unchanged if a sibling backend ever reuses the implementation.
- **The role is now an axis, not a one-off.** A future `processor-<backend>` follows this without another ADR; a package that is neither a store nor a processor still needs one, because inventing a scheme silently is what both this ADR and ADR-0014 exist to prevent.
- **A processor package may depend on a store package, and not the reverse.** `state-store-sqlite` is asserted to import nothing but `remote-sql` and `named-logs`, which is what keeps it a primitive. The dependency direction is therefore fixed by that test rather than by convention, and it is why the `LastSync` cursor table lives in the processor package.
