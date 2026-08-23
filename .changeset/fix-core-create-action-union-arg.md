---
'@etherfold/core': patch
---

Fix `createAction` losing its executor's parameter types when the action's argument type is a union.

`createAction<T, U>` chose the executor signature with `U extends undefined ? ... : ...`. `U` is a NAKED type parameter there, so the conditional DISTRIBUTES: for a union argument type such as `boolean` (`true | false`) it produced a UNION of two signatures rather than one signature taking the union. A union of signatures has no single call signature, so the executor's parameters silently fell back to implicit `any` and `next(...)` demanded the INTERSECTION of the constituents (`never`), refusing every real argument.

Both conditionals (`Func` and the `execute` parameter) now use the non-distributive `[U] extends [undefined]` form, which keeps `U` whole. No runtime behaviour changes and the public declarations are byte-identical; the internal module's `.d.ts` is the only emitted file that moves.

Found by the new `pnpm typecheck`, which is the first thing in this repo to typecheck `test/`: `test/promises.test.ts` had been calling `createAction<string, boolean>` since it was written, and nothing checked it.
