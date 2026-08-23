# @etherfold/state-store

The **seam**: what a store must do for a processor to run on it, and the vocabulary both sides speak. Zero dependencies, no SQL, no chain access, no platform.

```ts
import {MemoryStateStore, createMutationContext, type StateStore} from '@etherfold/state-store';

const store: StateStore = new MemoryStateStore([{name: 'token', id: ['id'], fields: {owner: 'text'}}]);
await store.migrate();

const {state, mutations} = createMutationContext(store); // one staging area per block
state.set('token', {id: '1'}, {owner: '0xalice'});
await store.applyBlock({number: 100, hash: '0xa', timestamp: 1_700_000_000}, mutations());

await store.getCurrent('token', {id: '1'}); // at the tip
await store.getAsOf('token', {id: '1'}, 99); // as of a block number: undefined, it did not exist yet
await store.listCurrent('placement', {epoch: 7}, 8); // the children of a key, bounded: {rows, truncated}
await store.revertTo(99); // a reorg: the write above is undone, counters go back DOWN
await store.prune(); // enforce the declared retention against storage; a no-op when there is none
```

## The vocabulary

- **entity declaration** — `{name, id, fields}`, and nothing else. The store owns the layout, the versions, the as-of read and the revert.
- **version** — a COMPLETE row with a half-open block-validity range. `set` writes a whole row, so a declared field it does not list becomes `NULL`; `delete` closes the live version without opening a new one, so the entity is absent from that block on and readable before it.
- **mutation context** — the write surface a handler gets for ONE block, with read-your-writes inside that block. `update` is sugar over get-then-spread-then-set, so the storage model stays visible.
- **listing** — the one SET read: the rows whose declared id starts with a PREFIX (a leading run of its id columns), ascending in the id's own order, bounded by a REQUIRED limit. No predicate, no caller-supplied ordering, no offset, so an accidental full scan cannot be expressed and the operation stays one indexed range scan on every backend. `truncated` says whether more matched, because a set that exactly fills the limit is otherwise indistinguishable from a cut-off one.
- **retention** — how far back superseded versions are kept, in BLOCK NUMBERS. Never in updates (on the real measured stream event-bearing blocks are median 429 apart, so a 64-block window holds one of them), never in time (that prunes on wall-clock rather than chain progress).
- **prune** — the enforcement of retention against STORAGE, as opposed to against answers. A window bounds what a read may ask about from the moment it is configured; `prune` is what drops the versions it no longer covers. It is an explicit call the host schedules, never a side effect of a write, because it costs time proportional to what it drops and a store is the wrong place to pick a maintenance cadence (ADR-0022). The LIVE version of an entity survives it however old it is: that row is the current state.
- **capabilities** — what a store declares about itself, readable before `migrate` and before any read, so a caller discovers a missing capability at startup instead of from a wrong answer.

## Why the seam is here and not lower

A processor could have been written against raw SQL, forcing wasm SQLite into every browser. It is written against this instead, because `MutationContext` is the MORE CONSTRAINED surface: a freer substrate can implement it, while backing arbitrary nested object mutation with versioned rows cannot be done without materialising the store. Two independent routes reached this boundary (`research/browser-embedded-indexer`, and the measured port in `work/notes/findings/sqlite-in-the-browser.md`, where a launched 13-handler processor produced state byte-identical to the original on 31,332 real events).

## What is deliberately NOT here

- **Any richer read.** The listing above is the whole of the set-read surface. A predicate, a sort or a page belongs to a backend that has a query planner under it (`queryCurrent` / `queryAsOf` in `@etherfold/state-store-sqlite`), because a handler runs once per event on every backend including the ones that have none. See ADR-0021.
- **Block addressing by hash or time**, and the refusal for an address that resolves to nothing. `getAsOf` takes a resolved block NUMBER; addressing is the read layer above (`@etherfold/state-store-sqlite`, ADR-0015).
- **The sync cursor.** Where a processor keeps `LastSync` is the processor package's business (ADR-0016).
- **Anything ABI-shaped.** The `on<EventName>` handler map is `@etherfold/processor-entities`, which depends on this package and on `@etherfold/core`. Keeping it out is what lets a storage backend depend on this package without inheriting the whole indexer. See ADR-0018.

## Implementations

- `MemoryStateStore`, here: versioned rows in a Map. The reference implementation, so the contract has an executable definition, and the second backend a portability test needs. It matches the SQL store down to the sharp edges (a re-applied block raises, an unlisted field goes to `NULL`) because a lenient reference implementation would let caller bugs through.
- [`@etherfold/state-store-sqlite`](../state-store-sqlite): versioned rows over `remote-sql`.

## Tests

`pnpm --filter @etherfold/state-store test`, vitest.

What the CONTRACT is, rather than what this package's reference store happens to do, is asserted by [`@etherfold/state-store-conformance`](../state-store-conformance): one suite, parameterised by a backend factory, asserting external behaviour only. `MemoryStateStore` is run through it under three retention claims, and that run lives in THAT package because it depends on this one and cannot be depended on back. A new backend earns its place behind this seam by passing the same suite.
