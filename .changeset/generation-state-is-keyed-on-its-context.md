---
'@etherfold/browser': patch
'@etherfold/core': patch
---

`GenerationContext` is now exported from `@etherfold/browser`, and the documentation no longer claims per-generation state is structural when it is a convention.

`GenerationSpec.createState` said the separate step made "each generation has its own state" structural rather than a convention a caller may forget. It does not and cannot: `State` is opaque to the container, so it cannot tell two stores apart, and two distinct store objects can address one underlying database anyway, which is invisible from there by construction and is the way this actually goes wrong.

The documentation now states the rule the caller has to keep: key the state on `context.stream`. Two generations under one storage location are ONE store by that backend's own definition, and they collide on the sync cursor as well as on the rows, because the cursor lives under a fixed key. The successor model, where the canonical generation keeps answering complete old answers while the new fold catches up, does not survive that.

`GenerationContext` is re-exported from `@etherfold/browser` because that package's own public `createState` signature names it, so a consumer could not write the factory with an explicit annotation.
