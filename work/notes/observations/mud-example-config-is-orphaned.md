---
title: '`examples/mud/src/config.ts` is imported by nothing and imported a module that never existed'
observed: 2026-08-27
source: 'found by turning the acceptance gate on for examples/ (ADR-0030): svelte-check on examples/mud failed on `Cannot find module ./lib/utils/web`. History read from `git log -- examples/mud/src/lib/utils/`.'
---

`examples/mud/src/config.ts` opens with

```ts
import {getHashParamsFromLocation, getParamsFromLocation} from './lib/utils/web';
```

`examples/mud/src/lib/utils/` has only ever contained `web3.ts`. **`web.ts` has never existed in this repository**, going back to `b98df28`, the commit that added the example. And `config.ts` is imported by nothing: neither `main.ts` nor `App.svelte` reference it.

So the example has been shipping with a module missing from it, and `pnpm --filter mud-demo build` is GREEN today, because `vite build` only resolves what it actually bundles and it never reaches an orphaned file. This is the cleanest available demonstration of ADR-0030's premise: a bundler is not a checker, and the thing it fails to check is precisely the code nothing imports.

## What was done, and what was not

`web.ts` was restored, by copying the three functions from the sibling `web-demo` example that they plainly came from. That is the NON-destructive way to make the gate green.

It is probably the wrong fix. The right one is almost certainly to **delete `config.ts`**, since nothing imports it and its two exports (`hashParams`, `params`) are read by nothing -- in which case the restored `web.ts` should go with it. That deletion is left to the maintainer rather than taken unilaterally: it removes a file, and the gate does not need it removed to be green.

If deleting: remove `examples/mud/src/config.ts` and `examples/mud/src/lib/utils/web.ts` together, then re-run `pnpm --filter mud-demo typecheck`.
