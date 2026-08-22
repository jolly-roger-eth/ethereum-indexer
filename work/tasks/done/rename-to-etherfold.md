---
title: Rename the project and packages to etherfold
slug: rename-to-etherfold
blockedBy: []
covers: []
---

## What to build

Execute the rename decided in `docs/adr/0017-rename-to-etherfold.md`: every published package moves from `ethereum-indexer*` to the `@etherfold` scope, the two unpublished scoped packages move from `@ethereum-indexer/*` to `@etherfold/*`, and every reference in the tree follows. The migration shape is ADR-0014's expand/migrate/contract, unchanged: publish scoped, republish the old flat name as a thin re-export, then `npm deprecate` the old name pointing at the new one.

The tree still builds, tests and formats at every step, and `stratagems` / `stratagems-snapshots` keep resolving through the deprecated names.

### The surface, measured

191 TRACKED files mention `ethereum-indexer`. The raw `grep` count of 881 is mostly gitignored build output (`docs/api` 139, `docs/.vitepress` build artifacts 442, `packages/*/dist` 91, `node_modules` 83) which is regenerated, never edited.

| area | tracked files | treatment |
| --- | --- | --- |
| `.changeset/` | 37 | **leave alone**: historical record of what shipped under the old names |
| `packages/*/CHANGELOG.md` | 9 | **leave alone**, same reason |
| `packages/` (src, test, package.json, README, TODO) | 72 | mechanical, except the package.json renames |
| `examples/` | 25 | mechanical: workspace deps and imports |
| `work/` | 23 | judgement: task and note prose referring to package names |
| `docs/` | 17 | judgement: 6 ADRs, 6 reviews, index, design doc, web-config |
| root | 7 | `README.md`, `CONTEXT.md`, `package.json`, `typedoc.json`, `zellij.kdl`, `.gitignore`, `pnpm-lock.yaml` |
| `media/` | 1 | the brand README |

### Mechanical versus judgement

**Mechanical** (a rename with review, not a rewrite): source imports, `package.json` names and dependency edges, workspace globs, directory names under `packages/` (leaf name, per ADR-0014), `named-logs` namespaces, typedoc entry points, the zellij launcher, example apps.

**Judgement, do NOT sed**:

- **Existing ADRs** (0003, 0006, 0010, 0014, plus any other mention). An ADR records what was decided AT THE TIME under the name in use then. Rewriting the name inside an accepted ADR falsifies the record. Prefer leaving the prose and letting ADR-0017 carry the mapping; where a bare package name would actively mislead a future reader, add a pointer rather than substituting the word.
- **`docs/reviews/`** (6 files): same principle, these are dated findings.
- **`work/` items** (23 files): backlog tasks describe work not yet done, so those SHOULD say `@etherfold/*` going forward, but `work/tasks/done/*` is a historical record and stays as written.
- **`CONTEXT.md`**: the domain glossary needs the new name in its opening framing, and the term definitions themselves are name-independent.
- **The brand assets**: only the two `<text>` elements in `lockup.svg` and `lockup-dark.svg`, then re-outline and rerun `build.sh` and push the copies out, per `media/logo-concepts/final/README.md`. A one-word wordmark replaces two stacked lines, so the lockup needs re-centering and probably a larger size. The mark itself does not change.

## Acceptance criteria

- [ ] Every package in `packages/` is named `@etherfold/<leaf>`, its directory is `<leaf>`, and `publishConfig.access` is `"public"`.
- [ ] Packages on ADR-0010's retirement path (`ethereum-indexer-db-processors`, `ethereum-indexer-db-utils`) are NOT renamed.
- [ ] `pnpm install && pnpm build && pnpm test && pnpm format:check` all pass from a clean checkout.
- [ ] Every example builds and runs against the renamed workspace packages.
- [ ] `.changeset/*` and every `CHANGELOG.md` are untouched by the rename pass, verifiable in the diff.
- [ ] No accepted ADR has had a package name silently substituted inside its prose; any needed clarification is an addition, attributed to ADR-0017.
- [ ] A changeset accompanies the rename for every package whose published API surface is affected.
- [ ] The deprecation plan is executable and written down: for each published old name, the re-export release and the exact `npm deprecate` message.
- [ ] `docs:build` succeeds and the generated `docs/api` carries the new names.
- [ ] The brand lockup and previews are regenerated with the new wordmark, and the mark's geometry is unchanged.
- [ ] `grep -r "ethereum-indexer"` over tracked files returns ONLY the deliberate historical mentions listed above.

## Blocked by

- None. Both open questions were answered before the build:
  1. Flat `etherfold` is the **umbrella CLI**, wrapping the server CLI when that lands, so it can later carry non-server subcommands. `@etherfold/cli` therefore keeps its `ei` bin. Recorded in ADR-0017.

  > **Amendment, after the answer above and before the branch was finished.** Question 1's second sentence is superseded and did NOT ship. The CLI package is not `@etherfold/cli`: it is the flat package **`etherfold`**, and its bin is **`etherfold`**, not `ei`. The reasoning is in ADR-0017 (the CLI is the one package outside the scope, because the package that installs a command should be named after the command, which also removes the later bin-ownership handoff). Two consequences the original answer did not anticipate: the `ei` command no longer exists, which is **user-facing breakage** for anything shelling out to it (`stratagems-snapshots` CI does), and the CLI's `named-logs` namespaces moved from `ei` / `ei:keepState` to `etherfold` / `etherfold:keepState`.
  2. The **repository moves later**, so every `jolly-roger-eth/ethereum-indexer` URL, the Pages base path and the `repository` / `homepage` fields were deliberately left untouched.

## Prompt

> Execute the `etherfold` rename in this monorepo.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED). Read `docs/adr/0017-rename-to-etherfold.md` (the decision and the full package mapping), `docs/adr/0014` (the scope migration mechanics this inherits: expand/migrate/contract, `<role>-store-<backend>`, directory follows leaf name, `publishConfig.access` is mandatory), and `docs/adr/0010` (which packages are retiring and therefore must NOT be renamed). If any of those have moved, do not build on the stale premise: route to needs-attention with the discrepancy.
>
> The measured surface is 191 tracked files; the much larger raw grep count is gitignored build output. The split between mechanical renames and judgement calls is in the task body above, and the single most important rule is that HISTORICAL RECORDS ARE NOT RENAMED: `.changeset/*`, every `CHANGELOG.md`, `work/tasks/done/*` and the prose inside already-accepted ADRs and `docs/reviews/*` record what was true under the old name. Substituting names inside them falsifies the record. When in doubt, leave the text and add a pointer.
>
> Work in dependency order so the tree keeps building: core, then the packages that depend on it, then examples. Run `pnpm build` and `pnpm test` between layers rather than only at the end, because a rename that breaks resolution fails in a hundred places at once and the first failure is the informative one.
>
> Do NOT publish anything and do NOT run `npm deprecate`. Publishing is a human step (see the release script in the root `package.json`). Your output for that part is a written, ordered plan: which package publishes first, what the re-export shim for each old flat name contains, and the exact deprecation message for each.
>
> The brand work is narrow: only the `<text>` elements in `lockup.svg` and `lockup-dark.svg` change, then re-outline and rerun `build.sh` and copy the outputs to the five destinations listed in `media/logo-concepts/final/README.md`. The mark carries no letterforms and its geometry must not change. A one-word wordmark replaces two stacked lines, so re-center it and expect to want a larger font size.
>
> RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT. Renames force small judgement calls (whether a given doc mention is historical or live, how to phrase a pointer inside an ADR, what a shim re-exports); those are exactly what belongs in that block. Do no git operations and do not edit this task body.

---

### Claiming this task

```sh
# atomically claim it (works with a GitHub remote OR a local --bare remote):
dorfl claim rename-to-etherfold --arbiter <remote>      # default --arbiter origin
# then start work on the updated main:
git fetch <remote> && git switch -c work/rename-to-etherfold <remote>/main
# on completion, in the work branch's PR/merge:
git mv work/tasks/ready/rename-to-etherfold.md work/tasks/done/rename-to-etherfold.md
```
