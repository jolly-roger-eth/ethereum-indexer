---
title: Generate the read surface from the entity declarations, so there is no second description of the data
slug: query-surface-from-entity-declarations
spec: one-processor-everywhere
blockedBy: [portable-mutation-context-seam, retention-capability-and-refusal]
covers: [8]
---

## What to build

A typed read surface derived from the same entity declarations that drive storage, so an application developer does not hand-write and hand-maintain a second description of their data.

The declarations are already the schema source: `{name, id, fields}` per entity, with the store owning the version columns, the DDL, the as-of rewrite and the revert. What is missing is that a consumer reading the state has to know the table names and the column names by hand, which is exactly the drift this spec exists to remove on the write side.

Scope it narrowly and honestly. This is NOT the GraphQL frontend: that stack is already decided elsewhere on measured evidence (Hono, then Yoga, then Pothos, built programmatically from the same model, no SDL and no deploy-time codegen) and is explicitly out of this spec's scope. What this task guarantees is the thing that stack will consume: a read API generated from the declarations, typed off them, so adding GraphQL later is an ADDITION rather than a refactor. The example continues to ship hand-written routes.

The surface follows the reads that already exist and the ones this spec adds: read one entity by id, current and as of a block address (hash, height or timestamp); list by a prefix of the declared id with a limit; and, on the server side where a query planner exists, the richer filtered form the store already offers through `queryCurrent` / `queryAsOf`. Keep the two tiers distinct and say why in the code: the handler-facing seam is bounded by construction because it runs once per event on every backend, while the server-side read layer may take predicates because it does not.

Two behaviours are non-negotiable and both already have their answer. An unresolvable block address is an ERROR, not an empty result (ADR-0015). And a historical read a backend cannot serve is the typed refusal from `retention-capability-and-refusal`, never a tip read, so the generated surface must propagate that refusal rather than swallowing it into `undefined`.

Types matter more than functions here. The value of generating is that a consumer gets `id` and `fields` typed off the declaration, so renaming a field breaks compilation rather than returning `undefined` at runtime. If the generated surface is not type-safe against the declaration, it has not solved the problem it exists for.

Note the `uint256` gap while you are here, because it lands on the read side hardest: there is no u256 column type, so a u256 is decimal TEXT read back through `BigInt()`, and equality then depends on an encoding nothing in the model states. Whether the generated surface decodes it (and therefore has to know a field is a u256, which the declaration currently cannot say) is a real question. If the answer is that the declaration needs to carry it, that is a decision worth an ADR and possibly a follow-on task, not a silent `as` cast.

## Acceptance criteria

- [ ] Given a set of entity declarations, a consumer gets a typed read surface without writing a second description of the entities: read by id (current and as-of), and list by id prefix with a limit.
- [ ] The types are derived from the declaration, so renaming a field or a key column breaks compilation at the consumer. A type-level test pins this.
- [ ] An unresolvable block address produces the existing error rather than an empty result, and a historical read outside a backend's retention produces the typed refusal. Neither becomes `undefined`.
- [ ] The surface works against at least two backends, unchanged.
- [ ] The server-side richer query form stays available and stays distinct from the bounded handler seam, with the reason stated where a reader will meet it.
- [ ] Nothing in this task ships GraphQL, and nothing in it blocks GraphQL being added later without a refactor. State briefly how the model would be consumed by the decided Yoga/Pothos stack.
- [ ] The `uint256` decoding question is answered explicitly rather than cast away, and if it needs the declaration to carry more, that is recorded.
- [ ] Tests in the affected packages' `test/`, vitest, plus a changeset.

## Blocked by

- `portable-mutation-context-seam`: the declarations must live in their backend-neutral home first.
- `retention-capability-and-refusal`: the refusal this surface has to propagate.

## Prompt

> Generate the read surface from the entity declarations in the `etherfold` monorepo, so the entity declaration is the single description of the data for both storage and reads.
>
> FIRST, check this task against current reality: read `work/specs/proposed/one-processor-everywhere.md` (or `work/specs/tasked/`), confirm `portable-mutation-context-seam` and `retention-capability-and-refusal` landed as assumed. Read `packages/state-store-sqlite/src/types.ts` (the declaration surface and its doc comment explaining why it is deliberately small), `src/store.ts` (`getCurrent`, `getAsOf`, `queryCurrent`, `queryAsOf`), `src/blocks.ts` and ADR-0015.
>
> The vocabulary: an ENTITY DECLARATION is `{name, id, fields}`; a BLOCK ADDRESS is a hash, a height or a timestamp; AS-OF is a read at a past block address; RETENTION is a declared capability in block numbers, and a read outside it is a typed refusal, never a tip read.
>
> Keep the scope honest. This is NOT GraphQL. That stack is already researched and decided (Hono, then Yoga, then Pothos, built programmatically from the same model, no SDL and no deploy-time codegen) and is out of this spec's scope; what this task guarantees is the schema source it will consume, so that adding it later is an addition and not a refactor. The example keeps shipping hand-written routes.
>
> Keep the two read tiers distinct and explain the asymmetry where a reader will meet it: the handler-facing seam is bounded by construction (a prefix of the declared id plus a required limit, no predicates) because a handler runs once per event on every backend including ones with no query planner; the server-side read layer may take predicates because it does not have that constraint.
>
> The point is TYPE SAFETY against the declaration. If renaming a field does not break compilation at the consumer, this task has not delivered its reason for existing.
>
> Done means: a consumer reads state without naming a table or a column by hand, errors stay errors, and the GraphQL layer could be added on top without changing this.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your final report, in particular the `uint256` decoding answer, which may need the declaration to carry more than it does today.
