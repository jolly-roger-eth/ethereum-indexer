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
