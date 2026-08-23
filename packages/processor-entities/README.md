# @etherfold/processor-entities

Write a processor **once**, run it wherever its state has to live. Declare entities, write `on<EventName>` handlers against a `MutationContext`, and hand the result to any [`@etherfold/state-store`](../state-store) backend.

```ts
import {applyEventStream, type EntityProcessor} from '@etherfold/processor-entities';

const processor: EntityProcessor<typeof abi> = {
	version: '1.0.0',
	entities: [{name: 'token', id: ['id'], fields: {owner: 'text', transferCount: 'integer'}}],
	async onTransfer(state, event) {
		const id = event.args.id.toString();
		const token = await state.get<{transferCount: number}>('token', {id});
		state.set('token', {id}, {owner: event.args.to, transferCount: (token?.transferCount ?? 0) + 1});
	},
};

// the same object, against versioned SQL rows on a server or a Map in a test
await applyEventStream(store, processor, eventStream, undefined);
```

Nothing in that object names a backend, which is the whole point: where the state physically lives is a deployment choice the processor neither sees nor encodes. `test/two-backends.test.ts` runs this exact processor against `@etherfold/state-store-sqlite` and against `MemoryStateStore` and asserts the resulting state is the same.

## What you get, and what it costs

- **`set` writes a WHOLE row.** A version is a complete row, not a delta, so a declared field `set` does not list becomes `NULL`. `update(entity, id, partial)` is sugar over get-then-spread-then-set for the counter case; it is spelled as sugar so the storage model stays visible.
- **Read-your-writes within the block.** `get` answers from the mutations already staged for the block being processed. It is load-bearing, not theoretical: on the real measured stream, 16,871 of 66,113 reads were served from the block's own staging area.
- **Handlers are uniformly async.** Typing reads as `T | Promise<T>` instead would be infectious at every call site, to save a microtask on a path dominated by fetching logs.
- **Model a one-to-many as children keyed by their parent**, the way a subgraph's `@derivedFrom` does, and read the collection back with a bounded listing:

  ```ts
  // entity: {name: 'placement', id: ['window', 'ordinal'], fields: {epoch: 'integer'}}
  const {rows, truncated} = await state.list('placement', {window: 'global'}, 8);
  ```

  The prefix is a LEADING run of the declared id columns, the limit is REQUIRED, the order is the id's own ascending order, and there is no `where`, no `orderBy` and no offset: that is what keeps it one indexed range scan on every backend a handler might run on (ADR-0021). Nothing is maintained at write time, so appending a child costs one row.
- **Key ordered children by something naturally unique** (an event ordinal, or `(blockNumber, logIndex)`) rather than by a dense array position, and make a key that must sort numerically FIXED-WIDTH, because a listing is ordered lexicographically over the stringified id. The measured port that validated this model paid for ignoring the first rule with three entities and a hand-maintained CSV index; see `work/notes/findings/sqlite-in-the-browser.md` and `test/ordered-children.test.ts`, which models the same window of seven with no index, no count and no stored array.

## Where the pieces live

| | |
| --- | --- |
| `EntityProcessor`, `EventHandlers` | here: the ABI-typed authoring surface |
| `applyEventStream`, `runBlockHandlers`, `forkPoint`, `groupByBlock` | here: revert-then-apply, once, for every backend |
| `MutationContext`, `EntityDeclaration`, `StateStore`, capabilities | [`@etherfold/state-store`](../state-store): what a store must understand |
| `EventProcessor`, the sync cursor, a read view | a backend's processor package, e.g. [`@etherfold/processor-sqlite`](../processor-sqlite) |

ADR-0018 records why this is a separate package from `@etherfold/state-store` rather than one: a storage backend must be able to depend on the seam without inheriting `@etherfold/core`.

## Tests

`pnpm --filter @etherfold/processor-entities test`, vitest.
