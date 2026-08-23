---
title: 'Two different business keys become one row on the memory and patch backends when an id VALUE contains U+0000'
slug: id-values-containing-nul-collide-on-the-string-keyed-backends
observed: 2026-08-23
source: 'task:declaration-legality-is-one-rule-everywhere, while auditing the identifier rules at the seam'
---

`entityKey` (`packages/state-store/src/entities.ts`) joins the entity name and the stringified id values with `\u0000`, and `MemoryStateStore` and `@etherfold/state-store-patch` use that string as their map key. So for `id: ['x', 'y']`, the keys `{x: 'a\u0000b', y: 'c'}` and `{x: 'a', y: 'b\u0000c'}` produce the same string and become ONE row: writing both in one block leaves the second overwriting the first, and both `getCurrent` calls return it. Verified on `MemoryStateStore` on 2026-08-23. The SQLite backend keeps them apart (separate columns) and IndexedDB does too (an array key).

Same defect SHAPE as `entity-names-differing-only-in-case-collide-on-sqlite` (one input, different meanings on different backends), but at the VALUE level rather than the declaration level, so the declaration-time refusal that closed the identifier half cannot reach it: nothing about `{name, id, fields}` says what the values will be. Not touched here (out of scope: this task closed the DECLARATION half). Likely fixes are a length-prefixed or escaped join in `entityKey`, or a separator no `String(value)` can produce.
