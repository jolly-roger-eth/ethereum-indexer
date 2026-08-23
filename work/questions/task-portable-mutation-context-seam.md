<!-- dorfl-sidecar: item=task:portable-mutation-context-seam type=task slug=portable-mutation-context-seam allAnswered=false -->

## Q1

**'task:portable-mutation-context-seam' was bounced — how should we proceed?**

> acceptance gate failed (exit 254) on the rebased tip — the failing step was: `pnpm format:check && { [ "$GITHUB_HEAD_REF" = "changeset-release/main" ] && echo 'skip changeset status on the Version PR (it consumes changesets)' || pnpm changeset status --since=main; } && pnpm build && pnpm typecheck && pnpm test`; its last output was:
>
> platforms/cf-worker build: Your Worker has access to the following bindings:
> platforms/cf-worker build: Binding                    Resource
> platforms/cf-worker build: env.DB (etherfold-db)      D1 Database
> platforms/cf-worker build: --dry-run: exiting now.
> platforms/cf-worker build: Done
> packages/browser build$ rm -rf dist && tsc
> packages/cli build$ rm -rf dist && tsc
> packages/fs build$ rm -rf dist && tsc
> packages/ethereum-indexer-server build$ rm -rf dist && tsc && cp -r templates dist/
> packages/fs build: Done
> packages/processor-entities build$ rm -rf dist && tsc
> packages/browser build: Done
> packages/cli build: Done
> packages/ethereum-indexer-server build: Done
> packages/processor-entities build: Done
> packages/processor-sqlite build$ rm -rf dist && tsc
> packages/processor-sqlite build: Done
> undefined
>  ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command "typecheck" not found
> Did you mean "pnpm format:check"?

<!-- q1 fields: id=q1 kind=stuck -->

**Your answer** (write below this line):
