---
'@etherfold/state-store': minor
'@etherfold/state-store-sqlite': minor
'@etherfold/state-store-conformance': minor
'@etherfold/processor-entities': patch
---

A handler can now ask about a SET of rows: the bounded id-prefix listing.

```ts
// entity: {name: 'placement', id: ['epoch', 'position', 'playerIndex'], fields: {player: 'text'}}
const {rows, truncated} = await state.list('placement', {epoch: 7}, 8);
```

That is the one read the entity model was missing, and it is what makes a one-to-many expressible the way a subgraph's `@derivedFrom` does it: children are their own entity keyed by their parent, and the collection is DERIVED WHEN READ. Nothing is maintained at write time. `MutationContext` gains `list`; `StateStore` gains `listCurrent` and `listAsOf`, which every backend must implement.

**The bound is the decision, not an implementation detail.** A listing takes a PREFIX of the declared id (a leading run of its id columns, at least one) plus a REQUIRED limit, and takes no `where`, no `orderBy` and no offset. A handler runs once per event on every backend, including the ones with no query planner, so the seam gets the one shape that is an indexed range scan everywhere: a key-prefix range with a bound. An accidental full scan is therefore impossible to EXPRESS rather than merely discouraged. `@etherfold/state-store-sqlite`'s `queryCurrent` / `queryAsOf`, which do take caller-supplied SQL, are the server-side read layer and are unchanged. See `docs/adr/0021`.

- **Truncation is reported, never inferred.** A listing answers `{rows, truncated}`, and every backend reads one row more than the limit to fill it in, because `rows.length === limit` cannot tell an exact answer from a cut-off one and a cascade delete that guesses wrong leaves orphans silently.
- **Order is the id's own, ascending**, which is what a range scan gives for free, and therefore LEXICOGRAPHIC over the stringified id: `'10'` sorts before `'9'`. Key ordered children by something naturally unique and ordered (an event ordinal, or `(blockNumber, logIndex)`) and make a numeric key fixed-width. If arrival order is wanted, that is a modelling answer, not a parameter.
- **Read-your-writes holds for a listing too**: a child written earlier in the block appears and one deleted earlier in the block does not, which means merging the block's staging area into the scan rather than falling through to the store. The fetch budget accounts for staged deletes, so a limit is still filled from beyond them.
- **In SQLite it is one indexed range scan**: equality on the leading id columns plus `ORDER BY` the declared id rides the entity's id index with no sort and no table scan. Pinned by the generated statement's shape AND by `EXPLAIN QUERY PLAN`, since no behavioural assertion can tell a range scan from a table scan that returns the same rows.
- **The conformance suite gained a group for it**, so a new backend is held to the same answers, and `@etherfold/processor-entities` gained a test that models the real ordered bounded collection from `work/notes/findings/sqlite-in-the-browser.md` (a window of seven, evicting the oldest and everything nested under it) with no stored array, no CSV index and no count, on both backends.
