<!-- dorfl-sidecar: item=task:handler-types-do-not-lie-when-one-name-covers-two-events type=task slug=handler-types-do-not-lie-when-one-name-covers-two-events allAnswered=false -->

## Q1

**'task:handler-types-do-not-lie-when-one-name-covers-two-events' was bounced — how should we proceed?**

> acceptance gate failed (exit 1) on the rebased tip — the failing step was: `pnpm format:check && { [ "$GITHUB_HEAD_REF" = "changeset-release/main" ] && echo 'skip changeset status on the Version PR (it consumes changesets)' || pnpm changeset status --since=main; } && pnpm build && pnpm typecheck && pnpm test`; its last output was:
>
> examples/web-demo typecheck: 	import type {EIP1193Provider} from 'eip-1193';
> examples/web-demo typecheck: 	import {createProcessor, contractsData} from 'event-processor-bleeps';
> examples/web-demo typecheck: 	import {derived} from 'svelte/store';
> examples/web-demo typecheck: /tmp/dorfl-fresh-gate-yP71bb/tip/examples/web-demo/src/pages/Bleeps.svelte:31:9
> examples/web-demo typecheck: Error: '$state' is of type 'unknown'. (ts)
> examples/web-demo typecheck: 	const nfts = derived(state, ($state) => ({
> examples/web-demo typecheck: 		nfts: $state.bleeps.map((v) => ({
> examples/web-demo typecheck: 			tokenAddress: contractsData[0].address,
> examples/web-demo typecheck: /tmp/dorfl-fresh-gate-yP71bb/tip/examples/web-demo/src/pages/Bleeps.svelte:31:28
> examples/web-demo typecheck: Error: Parameter 'v' implicitly has an 'any' type. (ts)
> examples/web-demo typecheck: 	const nfts = derived(state, ($state) => ({
> examples/web-demo typecheck: 		nfts: $state.bleeps.map((v) => ({
> examples/web-demo typecheck: 			tokenAddress: contractsData[0].address,
> examples/web-demo typecheck: ====================================
> examples/web-demo typecheck: svelte-check found 11 errors and 0 warnings in 5 files
> examples/web-demo typecheck: Failed
> /tmp/dorfl-fresh-gate-yP71bb/tip/examples/web-demo:
>  ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  web-demo@ typecheck: `svelte-check --tsconfig ./tsconfig.json`
> Exit status 1
>  ELIFECYCLE  Command failed with exit code 1.

<!-- q1 fields: id=q1 kind=stuck -->

**Your answer** (write below this line):

## Q2

**'task:handler-types-do-not-lie-when-one-name-covers-two-events' was bounced — how should we proceed?**

> The task's own work is DONE and green on `work/task-handler-types-do-not-lie-when-one-name-covers-two-events`; what blocks it is a REPO-WIDE gate defect that no change to this task can fix, so it needs a human decision (or its own task) rather than another build attempt.
>
> EVIDENCE THE BLOCKER IS NOT THIS CHANGE: I cloned pristine `main` (`a1d4fbb` — none of this task's commits) to a fresh directory and ran the gate's own sequence. `pnpm install --frozen-lockfile` OK, `pnpm build` OK, `pnpm typecheck` EXIT 1 with the same 11 errors the bounce reported: `examples/web-demo`, `Cannot find module 'event-processor-bleeps' / 'event-processor-nfts' / 'event-processor-conquest-eth' or its corresponding type declarations`, plus the knock-on `'$state' is of type 'unknown'` and `Parameter 'v' implicitly has an 'any' type`. `verify` is therefore red on main for EVERY change since `3143293`.
>
> THE DEFECT, PRECISELY: root `package.json` — `"build": "... --filter './packages/*' --filter './platforms/*' build"` but `"typecheck": "... --filter './packages/*' --filter './platforms/*' --filter './examples/*' typecheck"`. `examples/web-demo` resolves `event-processor-*` through their `dist/` (`"types": "dist/index.d.ts"`), and only `build:examples` produces that. Neither `dorfl.json`'s `verify` (`pnpm build && pnpm typecheck && pnpm test`) nor `.github/workflows/ci.yml` (which does not run `typecheck` at all, and runs `build:examples` only AFTER `test`) ever builds examples before typechecking them. CONTEXT.md's Conventions section asserts "The acceptance gate already sequences them that way", which is now false for `examples/*`. Confirmed locally: `pnpm build:examples` once, then `pnpm typecheck`, exits 0 on this branch.
>
> WHY I DID NOT JUST FIX IT: it is a gate-policy choice with several defensible answers, touching `build`, `prepare`, `prepublishOnly`, `release:ci`, `dorfl.json` and the CI workflow — i.e. every other task, not this one. Options for whoever resolves it: (a) add `--filter './examples/*'` to root `build` (also changes `prepare`/`prepublishOnly`, and `web-demo`'s build is a full `vite build`); (b) prefix root `typecheck` with `pnpm build:examples`; (c) put `pnpm build:examples` into `dorfl.json`'s `verify` between `build` and `typecheck` (and mirror it in CI); (d) point the example packages' `types` at `src/` so no build is needed. Suggested re-scope: a separate task, "the acceptance gate is green on a clean clone", owning that choice plus the CONTEXT.md sentence; this task then re-runs unchanged and passes.
>
> STATE OF THIS TASK'S WORK (verified this run, nothing left to build): `InputValues` distributes in both `packages/js-processor/src/processor/types.ts` and `packages/processor-entities/src/types.ts`; reverting either copy to the non-distributive form makes `pnpm typecheck` fail with `TS2322` on the union assertion and `TS2578: Unused '@ts-expect-error'` on the un-narrowed read, in both `packages/js-processor/test/handlerArgs.test.ts` and `packages/processor-entities/test/handler-args.test.ts`, so both assertions genuinely bite; the single-version `IsExactly` assertion is green in BOTH the reverted and fixed states, which is the "common case pays nothing" criterion; the changeset covers both packages at `minor`; no signature-keyed handler names were added. `format:check`, `changeset status --since=main`, `build`, and `test` (every package, 0 failures) are green on this branch, and `typecheck` is green after one `pnpm build:examples`. I made no source change and no git operation this run; the tree is clean.

<!-- q2 fields: id=q2 kind=stuck -->

**Your answer** (write below this line):
