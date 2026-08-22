---
title: Publish the etherfold packages and deprecate the old names
slug: publish-etherfold-and-deprecate-old-names
humanOnly: true
blockedBy: [rename-to-etherfold]
covers: []
---

## What to build

The release half of ADR-0017. The rename landed in the tree; nothing has been published. This is the ordered sequence that puts the `@etherfold` packages on npm, migrates the two consumers we own, and retires the old names.

`humanOnly` because it publishes to npm and touches other repositories: it needs credentials and cross-repo judgement, and it is not reversible by a revert.

**There are no re-export shims, by decision.** ADR-0017 records why (the only consumers that a shim would serve are ours, and the cost is seven permanently maintained packages plus an `ei` bin that ADR-0017 retired). The consequence to hold in mind throughout: an unmigrated consumer does not follow the rename automatically. It keeps the last old release and stops receiving updates.

### Step 1: publish the new names

Nine packages, from a clean checkout of the merged rename, via the existing root script (`pnpm release`, which runs `format:check` + `build`, pushes, then `changeset publish`).

Watch for two things the changeset alone will not tell you:

- **`etherfold` publishes over a placeholder.** The flat name currently holds `0.0.0` with no bin; the CLI publishes at `0.6.30`, so it supersedes cleanly. Verify `npm view etherfold bin` afterwards actually reports the `etherfold` bin, because a placeholder with no `bin` field is exactly the sort of thing that silently stays `latest` if a publish half-fails.
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

**Do NOT deprecate `ethereum-indexer-server` or `ethereum-indexer-db-utils`.** Neither was renamed. They are live under their old names and retire separately under ADR-0010; deprecating them here would conflate two decisions and mislead anyone still on them.

### Step 4: close the loop

- `npm view <old-name>` reports the deprecation for all seven.
- A fresh `npm i @etherfold/browser @etherfold/js-processor` in an empty directory resolves and type-checks against a trivial processor.
- `npm i -g etherfold && etherfold --help` prints usage with the program name `etherfold`.

## Acceptance criteria

- [ ] All nine packages are on npm under their new names, and `npm view etherfold bin` reports the `etherfold` bin.
- [ ] `stratagems` and `stratagems-snapshots` build and pass CI against the new names, with no `ei` invocation left.
- [ ] All seven renamed old names are deprecated with a message naming their replacement.
- [ ] `ethereum-indexer-server` and `ethereum-indexer-db-utils` are NOT deprecated.
- [ ] A clean-room install of the browser + js-processor pair works from the published registry, not just from the workspace.
- [ ] `etherfold --help` works from a global install.

## Blocked by

- `rename-to-etherfold` (done: the tree is renamed but unpublished).

## Notes for whoever runs this

Registering `etherfold.dev` belongs with this release rather than after it: `docs/web-config.json` already claims `https://etherfold.dev` as the canonical URL, and it does not resolve. The previous value (`https://ethereum-indexer.dev`) never resolved either, so this is not a regression, but publishing under a name whose canonical URL 404s is a bad first impression.

The repository has deliberately NOT moved (ADR-0017), so `jolly-roger-eth/ethereum-indexer` URLs, the Pages base path and the `repository` fields are all still the old ones. Package pages on npm will therefore link to a repo whose name does not match the package name until that move happens. That is expected, not a mistake to fix in a hurry.
