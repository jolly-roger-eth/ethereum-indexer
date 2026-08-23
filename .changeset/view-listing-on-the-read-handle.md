---
'@etherfold/processor-sqlite': minor
'@etherfold/state-store-sqlite': minor
---

The read handle `process()` hands back can use the bounded listing.

`VersionedStateView` forwarded six store methods and not the two that the listing added, so a consumer holding the handle -- which is what `@etherfold/processor-sqlite` actually publishes, and what `onStateUpdated` is given -- had to reach a one-to-many through `queryCurrent` and a hand-written `WHERE`. That is the surface the bounded listing exists to make unnecessary (ADR-0021), and it was unavailable at precisely the place it was meant to be used.

```ts
const view = await processor.process(events, lastSync);
const {rows, truncated} = await view.listCurrent('holding', {owner}, 20);
const then = await view.listAsOf('holding', {owner}, {hash}, 20);
```

- **`listAsOf` takes this backend's addressing**, a height, `{hash}` or `{timestamp}`, like the view's other as-of reads, and refuses the same two ways: an address identifying no block throws `NoSuchBlockError`, a block outside retention throws `BlockNotRetainedError`. Neither is answered from the tip.
- **The handle stays untyped**, entity names as strings with a caller-supplied row type. The typed reads generated from entity declarations are `createReadSurface` / `createQuerySurface`, and they are a deliberately separate thing; this is an omission closed, not a redesign.
- **`@etherfold/state-store-sqlite` now re-exports `EntityIdPrefix` and `Listing`** from the seam, alongside the seam vocabulary it already re-exported. Its own `listCurrent` / `listAsOf` signatures name those types, so a consumer of this package alone could not previously write down the argument or the result.
