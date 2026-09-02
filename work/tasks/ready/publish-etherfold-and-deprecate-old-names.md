---
title: Publish the etherfold packages and deprecate the old names
slug: publish-etherfold-and-deprecate-old-names
humanOnly: true
blockedBy: [rename-to-etherfold, a-snapshot-a-client-cannot-read-is-refused-not-installed]
covers: []
---

## What to build

The release half of ADR-0017. The rename landed in the tree; nothing has been published. This is the ordered sequence that puts the `@etherfold` packages on npm, migrates the two consumers we own, and retires the old names.

`humanOnly` because it publishes to npm and touches other repositories: it needs credentials and cross-repo judgement, and it is not reversible by a revert.

**There are no re-export shims, by decision.** ADR-0017 records why (the only consumers that a shim would serve are ours, and the cost is seven permanently maintained packages plus an `ei` bin that ADR-0017 retired). The consequence to hold in mind throughout: an unmigrated consumer does not follow the rename automatically. It keeps the last old release and stops receiving updates.

### Step 1: publish the new names

**EIGHTEEN publishable packages, not nine — re-derive the list, do not trust a number in this file.**
The count was nine when this task was written and the workspace has grown a lot since (the whole
`state-store*` family, `processor-entities`, `processor-sqlite`, `server`, `fetcher-host`, and two
under `platforms/*`). Derive it: every `package.json` under `packages/*` and `platforms/*` whose
`private` is not `true`. At the time of this correction that is 16 under `packages/*` plus
`@etherfold/platform-nodejs` and `@etherfold/platform-nodejs-fetcher`, with only
`@etherfold/conformance-workload-stratagems` and `@etherfold/platform-cf-worker` private.
`.changeset/config.json` has an EMPTY `ignore` and `privatePackages: false`, so changesets already
sees exactly that set.

Publish from a clean checkout via the existing root script (`pnpm release`, which runs `format:check`
+ `build`, pushes, then `changeset publish`).

Watch for two things the changeset alone will not tell you:

- **`etherfold` publishes over a placeholder.** The flat name currently holds `0.0.0` with no bin; the CLI publishes at **`0.7.0`** (re-check before publishing, it moves), so it supersedes cleanly. Verify `npm view etherfold bin` afterwards actually reports the `etherfold` bin, because a placeholder with no `bin` field is exactly the sort of thing that silently stays `latest` if a publish half-fails.
- **`publishConfig.access: "public"` matters on every scoped package.** npm defaults a scoped package to restricted, and a free org fails the publish outright rather than warning.

### Step 2: migrate the consumers we own

`wighawag/stratagems` and `wighawag/stratagems-snapshots`. Both currently resolve `ethereum-indexer*` names.

- Update the dependency names and imports to `@etherfold/*`.
- **`stratagems-snapshots` shells out to the CLI**: the `ei` command no longer exists, and the package that provided it is now `etherfold` with bin `etherfold`. This is the one piece of genuinely breaking, non-mechanical fallout from the rename.
- Any `named-logs` filter matching `ethereum-indexer*` needs to become `@etherfold/*`, and the CLI's own namespaces are now `etherfold` / `etherfold:keepState` (previously `ei` / `ei:keepState`).

Do this BEFORE step 3, so the deprecation warnings do not fire in your own CI.

### Step 3: deprecate the old names

Seven renamed packages. Deprecate every version, since no version of the old name forwards to the new one:

```sh
npm deprecate ethereum-indexer@"*"              "renamed to @etherfold/core (ADR-0017); no further updates will be published under this name"
npm deprecate ethereum-indexer-browser@"*"      "renamed to @etherfold/browser (ADR-0017); no further updates will be published under this name"
npm deprecate ethereum-indexer-js-processor@"*" "renamed to @etherfold/js-processor (ADR-0017); no further updates will be published under this name"
npm deprecate ethereum-indexer-fs@"*"           "renamed to @etherfold/fs (ADR-0017); no further updates will be published under this name"
npm deprecate ethereum-indexer-fs-cache@"*"     "renamed to @etherfold/fs-cache (ADR-0017); no further updates will be published under this name"
npm deprecate ethereum-indexer-utils@"*"        "renamed to @etherfold/utils (ADR-0017); no further updates will be published under this name"
npm deprecate ethereum-indexer-cli@"*"          "renamed to etherfold (ADR-0017); the command is now 'etherfold', not 'ei'"
```

**Do NOT deprecate `ethereum-indexer-server` or `ethereum-indexer-db-utils` — the ACTION is
unchanged, the REASON in this file was stale and is corrected here.** Neither was renamed, so neither
belongs in a rename deprecation sweep. What is no longer true is that they are "live under their old
names" in this repo: both were moved to **`archive/`**, which sits outside the `pnpm-workspace.yaml`
globs and is explicitly "not built, typechecked, tested, versioned or published". So they are live
only as PUBLISHED ARTIFACTS on npm, from their last release, with no source here that can produce
another. Their retirement is still ADR-0010's to sequence, and deprecating them under an ADR-0017
rename message would still misdescribe why. Decide their npm fate as its own step, not as a side
effect of this one.

### Step 4: close the loop

- `npm view <old-name>` reports the deprecation for all seven.
- A fresh `npm i @etherfold/browser @etherfold/js-processor` in an empty directory resolves and type-checks against a trivial processor.
- `npm i -g etherfold && etherfold --help` prints usage with the program name `etherfold`.

## Acceptance criteria

- [ ] **Every** non-private package under `packages/*` and `platforms/*` is on npm under its new name — the list DERIVED at publish time, not read off this file (18 at the time of writing) — and `npm view etherfold bin` reports the `etherfold` bin. A criterion naming a fixed count can pass while packages newer than the count go unpublished, which is the failure this wording exists to prevent.
- [ ] `stratagems` and `stratagems-snapshots` build and pass CI against the new names, with no `ei` invocation left.
- [ ] All seven renamed old names are deprecated with a message naming their replacement.
- [ ] `ethereum-indexer-server` and `ethereum-indexer-db-utils` are NOT deprecated as part of this task (they were archived, not renamed; their npm fate is ADR-0010's).
- [ ] A clean-room install of the browser + js-processor pair works from the published registry, not just from the workspace.
- [ ] `etherfold --help` works from a global install.

## Blocked by

- `rename-to-etherfold` (done: the tree is renamed but unpublished).
- `a-snapshot-a-client-cannot-read-is-refused-not-installed`. This edge is the enforcement of an
  ordering that was previously decided in PROSE and by nothing else: that task states it is "better
  done BEFORE `publish-etherfold-and-deprecate-old-names`, which is what turns this from an
  unreachable gap into a live one", but the constraint binds THIS task and nothing here carried it,
  so publish could legitimately have gone first. Today no format-1 snapshot exists in the wild and
  the fix is a guard that was always there; after publishing, the same fix is a breaking correction
  to a shipped package. One edge, and the asymmetry is permanent.

## Prompt

> Publish the `@etherfold` packages to npm, migrate the two consumers we own, and deprecate the seven
> renamed old names, in the `etherfold` monorepo. This is the release half of ADR-0017; the rename
> itself already landed in the tree.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED). This
> task has drifted TWICE already — the package COUNT and the repository-move note were both wrong
> when last reviewed — so re-derive rather than trust: the publishable set (`private` not true under
> `packages/*` and `platforms/*`), the CLI's current version, and what `npm view` says about each old
> name TODAY. If a dependency landed differently or an ADR superseded an assumption here, do NOT
> build on the stale premise — surface the discrepancy (WORK-CONTRACT.md, "Drift is a
> needs-attention signal").
>
> This task is `humanOnly` and it is NOT reversible by a revert: publishing a version to npm is
> permanent, and deprecation messages are public. Read ADR-0017 for why there are no re-export shims
> and what that means for an unmigrated consumer (it keeps the last old release and stops receiving
> updates). Work the four steps in order — publish, migrate `wighawag/stratagems` and
> `wighawag/stratagems-snapshots`, deprecate, verify — and do the migration BEFORE the deprecation so
> the warnings do not fire in your own CI.
>
> The one piece of genuinely breaking, non-mechanical fallout: `stratagems-snapshots` shells out to
> the CLI, and the `ei` command no longer exists.

## Notes for whoever runs this

Registering `etherfold.dev` belongs with this release rather than after it: `docs/web-config.json` already claims `https://etherfold.dev` as the canonical URL, and it does not resolve. The previous value (`https://ethereum-indexer.dev`) never resolved either, so this is not a regression, but publishing under a name whose canonical URL 404s is a bad first impression.

**The repository HAS now moved, so ADR-0017's "the repository does NOT move with the rename" is
history rather than current state, and the warning that used to live here is VOID.** Verified: the
`origin` remote is `git@github.com:wighawag/etherfold.git`, every `repository.url` under `packages/*`
and `platforms/*` reads `github.com/wighawag/etherfold`, and the Pages base is `/etherfold`. So npm
package pages will NOT link to a mismatched repo, and there is nothing to tolerate here. The only
surviving `jolly-roger` reference is an unrelated local `test:manual` script path in
`packages/cli/package.json`, which is a developer convenience pointing at a sibling checkout and is
not a rename leftover.
