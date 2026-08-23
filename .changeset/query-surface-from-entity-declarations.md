---
'@etherfold/state-store': minor
'@etherfold/state-store-sqlite': minor
'@etherfold/processor-entities': minor
---

The read surface is now GENERATED from the entity declarations, so `{name, id, fields}` is the single description of the data for storage and for reads.

```ts
const entities = declareEntities([{name: 'token', id: 'id', fields: {owner: 'text', transferCount: 'integer'}}]);

const store = new MemoryStateStore(entities); // the same array drives the storage...
const surface = createReadSurface(store, entities); // ...and types the reads

const token = await surface.token.getCurrent({id: '1'}); // {id: string; owner: string | null; ...} | undefined
await surface.placement.listCurrent({epoch: 7}, 8); // the children of a key, bounded
```

No table name, no column string, no hand-written row type. **Rename `owner` in the declaration and the consumer stops COMPILING**, instead of reading `undefined` in production, which is the whole reason the surface is generated rather than written beside the declaration.

- **Two tiers, one schema source.** `createReadSurface` (`@etherfold/state-store`) is the seam's four reads (`getCurrent` / `getAsOf` / `listCurrent` / `listAsOf`) and runs unchanged on every backend. `createQuerySurface` (`@etherfold/state-store-sqlite`) is those four PLUS `queryCurrent` / `queryAsOf`, which take caller-supplied SQL. The asymmetry is placement, not caution: the bounded tier is what a handler is held to, and a handler runs once per event on every backend including the ones with no query planner (ADR-0021), while a server-side reader runs per request with a planner underneath it.
- **The as-of parameter is whatever the STORE takes**, read off its own signature. Over a plain `StateStore` that is a block number; over `@etherfold/state-store-sqlite` it is a height, a `{hash}` or a `{timestamp}`. So a hash reaches the backend that can resolve one, and does not compile against a backend that cannot, with no new capability flag to declare.
- **Errors stay errors.** `NoSuchBlockError` (ADR-0015) and `BlockNotRetainedError` (ADR-0019) travel through the surface untouched; neither becomes `undefined`, which keeps its one meaning of "the block is known and the entity was absent from it".
- **Rows are PROJECTED to the declared columns**: id columns, then every declared field, with an unlisted one as `null` (a version is a whole row) and the version columns dropped, since they are storage rather than state and a projected row cannot be spread back into a write.
- **Nothing is decoded beyond the declared storage class**, so a `uint256` stored as decimal `text` comes back as the string it is and the consumer calls `BigInt()`. Decoding it would need the declaration to SAY a text column is a u256, which it cannot; ADR-0025 records the answer and leaves the field type itself to `tagged-bigint-codec-across-storage-adapters`.
- **`declareEntities` keeps a declaration's literal types** and changes nothing at run time. An annotated declaration (`const TOKEN: EntityDeclaration = ...`) widens `'owner'` to `string`, after which nothing can be derived from it.
- **Nothing here ships GraphQL, and nothing here blocks it.** The decided stack (Hono, then Yoga, then Pothos, built programmatically, no SDL and no deploy-time codegen) walks the same declarations for its object types and resolves them through this surface, so it is an addition rather than a refactor. The example keeps its hand-written routes.
