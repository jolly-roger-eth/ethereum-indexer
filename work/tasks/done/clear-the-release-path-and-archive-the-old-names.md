---
title: Clear the changeset backlog and move the pre-etherfold packages out of the workspace
slug: clear-the-release-path-and-archive-the-old-names
blockedBy: []
covers: []
---

## What to build

Make a release possible again, and stop the repository carrying three generations of package names at once.

**The release is blocked today.** `pnpm changeset status` (no `--since`) exits 1 with `Found changeset ... for package ethereum-indexer which is not in the workspace`. The acceptance gate only runs `changeset status --since=main`, which considers changesets added since main, so it passes and the breakage is invisible until someone runs a plain status, `changeset version`, or a release. Verified on `main` at `2a4e6ed`.

Roughly 30 pending changesets in `.changeset/` name packages that no longer exist, across THREE naming generations:

- unscoped first generation: `ethereum-indexer`, `ethereum-indexer-browser`, `ethereum-indexer-cli`, `ethereum-indexer-fs`, `ethereum-indexer-fs-cache`, `ethereum-indexer-js-processor`, `ethereum-indexer-utils`
- the intermediate scope: `@ethereum-indexer/processor-sqlite`, `@ethereum-indexer/state-store-sqlite`
- current: `@etherfold/*`

These are unconsumed RELEASE INTENTS for versions long since shipped under names that no longer exist. They are not history (git is), so deleting them is the honest fix rather than rewriting them to point at current packages, which would re-announce old changes as new ones. If any describes a change that genuinely has NOT shipped, that one is rewritten rather than deleted — check before sweeping, and say what you found.

**Two legacy packages are still in the workspace and still published-shaped**: `packages/ethereum-indexer-db-utils` (`ethereum-indexer-db-utils`) and `packages/ethereum-indexer-server` (`ethereum-indexer-server`). ADR-0010 already sentences both: `db-processors` is deleted (done — only an untracked `node_modules` shell remains locally, which is not a repository concern), and `db-utils` retires with the indexer-server, which ADR-0006 superseded.

Move them to `./archive/` — OUTSIDE the `pnpm-workspace.yaml` globs (`packages/*`, `examples/*`, `platforms/*`) — so they are readable as old code but are not built, tested, typechecked, versioned or published. Keeping them buildable is what makes them a standing tax; deleting them outright loses the reading material. Archiving is the middle answer and is what was asked for.

Check what still imports them before moving. If something live does, that is a finding worth surfacing rather than a reason to abandon the move.

**While you are here**, `work/notes/observations/adr-0016-rename-to-processor-js-never-happened.md`: ADR-0016 says the package migrates to `<scope>/processor-js` so one role's variants sort adjacent; ADR-0017's rename shipped `@etherfold/js-processor`, keeping the old word order, and nothing records the reversal. Two accepted ADRs name the same package differently and the shipped name is the one ADR-0016 argues against. Resolve it: either finish the rename or amend ADR-0016 to record that the ordering rule yielded here and why. Renaming a published package is the larger move and needs a changeset and a deprecation note; amending is legitimate if the rename is not wanted. Decide, do one, and delete the observation once it is no longer true.

Deprecating the old names ON NPM is NOT this task: `publish-etherfold-and-deprecate-old-names` owns that. This task makes the repository releasable and coherent; that one talks to the registry.

## Acceptance criteria

- [ ] `pnpm changeset status` (no `--since`) exits 0 on a clean checkout. This is the criterion that matters; the gate's `--since=main` form must keep passing too.
- [ ] Every deleted changeset is accounted for: a statement that they describe already-shipped releases under retired names, plus any exception you found and rewrote instead.
- [ ] `packages/ethereum-indexer-db-utils` and `packages/ethereum-indexer-server` are under `./archive/`, outside the workspace globs, and `pnpm install && pnpm build && pnpm typecheck && pnpm test` no longer touch them.
- [ ] Nothing live imports the archived packages, verified rather than assumed. If something does, it is reported.
- [ ] `./archive/` carries a README saying what these are, why they are kept, that they are not built or published, and which ADR retired them.
- [ ] The ADR-0016 / ADR-0017 naming contradiction is resolved one way or the other, and the observation note is deleted once it is no longer true.
- [ ] The full gate passes, and a changeset exists for any published package whose surface or existence changed.

## Prompt

> Make the `etherfold` monorepo releasable again and move the pre-`etherfold` packages out of the workspace (the repository directory is still named `ethereum-indexer`).
>
> FIRST reproduce the breakage: `pnpm changeset status` with NO `--since` exits 1 because pending changesets in `.changeset/` name packages that are not in the workspace. The acceptance gate only runs the `--since=main` form, which is why this has stayed invisible. Read `work/notes/observations/stale-changesets-name-packages-that-no-longer-exist.md`, then ADR-0010, ADR-0014 and ADR-0017 for the naming history.
>
> There are three generations of names in that folder: unscoped `ethereum-indexer*`, the intermediate `@ethereum-indexer/*` scope, and the current `@etherfold/*`. The stale ones are unconsumed release intents for versions already shipped under retired names. Deleting them is the honest fix; rewriting them to name current packages would re-announce old changes as new. CHECK first whether any describes something that genuinely never shipped, and rewrite only those.
>
> Then archive, do not delete, `packages/ethereum-indexer-db-utils` and `packages/ethereum-indexer-server`. ADR-0010 already retires both. Move them under `./archive/`, outside the `pnpm-workspace.yaml` globs, so they stay readable but are no longer built, typechecked, tested, versioned or published. Verify nothing live imports them before moving, and report it if something does. Old package names are NOT a compatibility constraint here.
>
> Also resolve `work/notes/observations/adr-0016-rename-to-processor-js-never-happened.md`: ADR-0016 mandates `<scope>/processor-js`, ADR-0017 shipped `@etherfold/js-processor`, and nothing records the reversal. Finish the rename or amend ADR-0016, deliberately, then delete the observation because it will no longer be true.
>
> Do NOT deprecate anything on npm; `publish-etherfold-and-deprecate-old-names` owns the registry side.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your final report: what you deleted versus rewrote, where the archive lives, and how you settled the ADR-0016 contradiction.

## Decisions

**Rewrote all ~30 stale changesets instead of deleting them; the task said delete.** The task's premise ("release intents for versions already shipped under retired names") is false: nothing has been released since 2024-08-29, and all 54 pending changesets were written in 2026, describing work that is in the tree and in no changelog (ESM-only `tsc` build, viem v2, `dispose()`, CLI exit codes, `blockTimestamp` off the log, the published-type-dependency fix). Deleting them would have discarded the entire relaunch changelog for ~18 months of work. The task's own instruction covers this ("if any describes a change that genuinely has NOT shipped, that one is rewritten") — the finding is simply that the exception is 100% of the set, which inverts its headline. I proceeded rather than stopped because the direction is information-preserving and cheap to reverse (`rm` on 33 text files, nothing published yet), whereas deleting first would be the expensive mistake. Alternative considered: delete as literally instructed and note the loss; rejected because "re-announce old changes as new" cannot apply to changes that were never announced. **Touches:** the relaunch changelog every `@etherfold/*` package will ship, and the version bumps `publish-etherfold-and-deprecate-old-names` will publish (core 0.6.21→0.7.0, browser 0.7.7→0.8.0, `etherfold` 0.6.30→0.7.0, and so on, rather than a bare rename note). **If the human wanted the deletion, this is the one thing to reverse.**

**Deleted 4 changesets rather than rewriting them: the ones that named only `ethereum-indexer-server`** (`fix-server-feed-route`, `server-indexing-robustness`, `server-route-errors-and-auth`, `server-use-shared-processor-setup`). Their package is archived and will never be published again, so there is no release for them to land in, and rewriting them onto `@etherfold/server` would attribute Koa/PouchDB work to a different codebase. To avoid losing the notes I transcribed all four bodies into `archive/ethereum-indexer-server/CHANGELOG.md` under `## Unreleased, and never will be`, with a one-line equivalent in `archive/ethereum-indexer-db-utils/CHANGELOG.md`. Alternative: delete outright; rejected as inconsistent with "archive, do not delete".

**Four examples DID depend on the archived server, so I unhooked them.** `event-processor-{bleeps,conquest-eth,conquest-fplay,nfts}` each had `"ethereum-indexer-server": "workspace:*"` plus `"eis": "eis"` and `"test": "eis run -p ./dist/index.js --disableCache"`. I removed the devDependency and both scripts. Not repointed at `etherfold`: the old `eis run` is a long-running server with a PouchDB store, the new `etherfold index` is a one-shot write-to-file, so there is no drop-in replacement, and `etherfold serve` does not yet take a processor path. These `test` scripts were manual runs against a live node, never invoked by the gate (root `test` filters `./packages/*` and `./platforms/*` only, and `typecheck-tests-in-the-acceptance-gate` already recorded that no example has a vitest suite). **Touches:** anyone who ran `pnpm --filter event-processor-nfts test` loses that command; a follow-up giving the examples a smoke test against `etherfold serve` would be legitimate work, but it is not this task.

**Settled ADR-0016 vs ADR-0017 by amending ADR-0016, not by renaming to `@etherfold/processor-js`.** Nothing is published under `@etherfold/*` yet (the rename changeset is still pending), so the rename would have cost zero npm churn; the amendment states that explicitly and refuses on the merits instead. The reason: the package's public API is the type `JSProcessor` and the factory `fromJSProcessor`, named in every processor file anyone writes. `@etherfold/processor-js` exporting `JSProcessor` re-creates the same mismatch one layer down, and fixing *that* means renaming the most-used authoring surface in the project — a real breaking change bought with sort order. ADR-0016's own consequence ("the class inside is named for the storage model, not the backend") assumes the backend does not appear in the API; for this package it does. `processor-sqlite` is unaffected (its export is `VersionedStateEventProcessor`). Alternative: finish the rename; rejected also because it would have invalidated `publish-etherfold-and-deprecate-old-names`'s step-3 runbook, which I must not edit. The amendment marks the exception as an exception, not a precedent: new `processor-<backend>` packages still follow the rule. **Touches:** ADR-0017's mapping table (now confirmed correct as written) and the sibling publish task (now unchanged).

**Added `archive/` to `.prettierignore`.** The criterion only asked for not built / typechecked / tested / versioned / published, so this goes slightly further: it stops a future prettier upgrade rewriting code nobody will read a diff of. Reversible in one line if the repo prefers uniform formatting.

**Added the guard test in `packages/core/test/`, not a new workspace-level harness.** It is not a core test; it reads `.changeset/` and the workspace manifests. It lives there because `publishedTypeDependencies.test.ts` already established that seam ("there is no workspace-level test harness") and inventing a second convention for the second such test is worse than reusing the first. **Touches:** if a workspace-level harness is ever created, both files move together.
