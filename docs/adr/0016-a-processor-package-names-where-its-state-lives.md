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

**Amended 2026-08-23: that one rename does not happen.** See the amendment at the end.

## Consequences

- **"Processor" keeps the meaning `CONTEXT.md` gives it**: the reducer contract, never a deployable. `processor-sqlite` is a library implementing `EventProcessor`, and the deployable that hosts one is still `@ethereum-indexer/server` (ADR-0003, ADR-0014).
- **The class inside is named for the storage model, not the backend.** `VersionedStateEventProcessor` sits beside `JSObjectEventProcessor`, because within a package the backend is already established by the package name, while the state model is the thing a reader needs told. That also leaves the class name usable unchanged if a sibling backend ever reuses the implementation.
- **The role is now an axis, not a one-off.** A future `processor-<backend>` follows this without another ADR; a package that is neither a store nor a processor still needs one, because inventing a scheme silently is what both this ADR and ADR-0014 exist to prevent.
- **A processor package may depend on a store package, and not the reverse.** `state-store-sqlite` is asserted to import nothing but `remote-sql` and `named-logs`, which is what keeps it a primitive. The dependency direction is therefore fixed by that test rather than by convention, and it is why the `LastSync` cursor table lives in the processor package.

## Amendment, 2026-08-23: the incumbent keeps its word order

**The `processor-js` rename above does not happen. The package is `@etherfold/js-processor`, and the ordering rule yields for it alone.** Everything else this ADR decides stands: the role-first shape governs every `processor-<backend>` package, and `@etherfold/processor-sqlite` and `@etherfold/processor-entities` follow it.

This was not decided when it happened. ADR-0017's mapping table renamed `ethereum-indexer-js-processor` to `@etherfold/js-processor` by swapping the prefix, which is what it did to all seven unscoped names, and never engaged with the one line of this ADR that asked for a different leaf. So the tree shipped a name this ADR argues against, with nothing recording why, and two accepted ADRs named the same package differently. An observation note caught it while ADR-0018 was being written; this amendment is the deliberate answer that retires it, and it goes to the shipped name rather than to the rule.

**Because the package's public vocabulary is `JSProcessor`, not `JS`-the-backend.** The exported surface is the type `JSProcessor` and the factory `fromJSProcessor`, and every processor anyone has written names both, in a file whose whole job is to define one. This ADR's own consequence says the class inside is named for the state model rather than the backend, on the grounds that the package name already establishes the backend and the reader needs told the model. `@etherfold/processor-js` exporting `JSProcessor` inverts that: the package would say `processor-js` while the API a consumer types says `JSProcessor`, and the only way to make the pair agree again is to rename the exported type and factory, which is a real breaking change to the most-used authoring surface in the project in exchange for sort order. `processor-sqlite` has no such problem, because its export is `VersionedStateEventProcessor` and its backend appears nowhere in its API.

**Sort adjacency was the whole benefit, and it is worth less than it looks.** The gain this ADR claims for role-first ordering is that variants of one role sit together in a scope listing. `@etherfold/js-processor` is one entry out of eleven and it is the one nobody has to go looking for, since it is half of the documented common path (`@etherfold/browser` plus `@etherfold/js-processor`). The adjacency argument is strongest for packages a reader is choosing BETWEEN, which is a real description of `processor-sqlite` beside a future `processor-postgres`, and a poor one of the in-memory processor everyone starts with.

**Renaming was affordable and is still refused.** Worth stating, because it is the obvious objection: nothing is published under `@etherfold/*` yet (the rename's changeset is still pending), so `processor-js` would have cost no npm churn, no deprecation and no second migration. It is refused on the merits above, not on cost. The counter-cost is not zero either: `js-processor` is the incumbent published leaf since 0.6.x, and changing its word order at the same moment as its scope makes one rename read as two.

### Consequences of the amendment

- **`@etherfold/js-processor` is a stated exception, not a precedent.** A new processor package is `processor-<backend>`; this ADR's rule is unchanged for everything that does not already exist. The exception exists because the package predates the rule and its API carries the old word order.
- **ADR-0017's table is correct as written** and needs no correction; `publish-etherfold-and-deprecate-old-names` deprecates `ethereum-indexer-js-processor` in favour of `@etherfold/js-processor`, which is the name that will exist.
- **The scope listing is not uniform**, and a reader who sorts it will find `js-processor` away from `processor-entities` and `processor-sqlite`. That is the accepted cost, and it is the cost this ADR originally paid to avoid.
