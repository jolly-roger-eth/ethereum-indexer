---
title: Add descriptions + READMEs to the published etherfold packages
slug: add-package-readmes-and-descriptions
covers: []
blockedBy: [retire-the-js-object-processor-path, drop-filesystem-storage-and-rehome-the-fixture-loader]
---

## What to build

Add a one-sentence `description` to every published package's `package.json` under `packages/*` and `platforms/*`, and a short, accurate `README.md` per package (what it is, when to use it vs. the alternatives, a minimal usage snippet, links to related packages). Verify each summary against the actual source and the real consumers (`wighawag/stratagems`, `wighawag/stratagems-snapshots`) before writing — do not guess the API. Docs + metadata only; no runtime behaviour changes.

**DERIVE the package list; the role list at the bottom of this file is STALE and is kept only as a starting point.** It was written when the workspace held nine packages and names three that are no longer in `packages/*` at all. Current reality, re-checked: `packages/ethereum-indexer-db-processors` and `ethereum-indexer-streams` are DELETED (zero tracked files); `ethereum-indexer-server` and `ethereum-indexer-db-utils` were moved to **`archive/`**, which is outside the `pnpm-workspace.yaml` globs and is explicitly "not built, typechecked, tested, versioned or published" — so they need no README and no description here, and any instruction below to write one for them is void. Meanwhile roughly eleven packages NEWER than that list (`server`, the whole `state-store*` family, `processor-entities`, `processor-sqlite`, `fetcher-host`, and the two under `platforms/*`) have no guidance in it at all. Work from `ls packages platforms` plus each manifest's `private` flag.

**Three packages in that set are being DELETED by other tasks; do not write READMEs for them.** `@etherfold/js-processor` goes with `retire-the-js-object-processor-path`, and `@etherfold/fs` and `@etherfold/fs-cache` go with `drop-filesystem-storage-and-rehome-the-fixture-loader`. Both are unblocked and may land in either order relative to this one, which is why this task is `blockedBy` them: documenting a package on its way out is pure waste, and the two deleters own the churn.

## Acceptance criteria

- [ ] Every non-private package under `packages/*` AND `platforms/*` has a truthful one-sentence `description` in `package.json`, with the set DERIVED at build time rather than read off this file.
- [ ] Every kept package has a `README.md` (role, when-to-use, minimal snippet, related links).
- [ ] Nothing in `archive/` gains a README or a description, and no README describes an archived or deleted package as a current option.
- [ ] Summaries verified against source + the real consumers (not guessed); status stated truthfully (cli = one-shot, NOT live-reconfigurable).
- [ ] A changeset covers the `package.json` `description` changes (a `patch` per changed package).
- [ ] Optional: a top-level README/docs section mapping the package graph (engine → processor authoring → run client / backend / persist).

## Blocked by

- `retire-the-js-object-processor-path` and `drop-filesystem-storage-and-rehome-the-fixture-loader` — both DELETE packages this task would otherwise document (`@etherfold/js-processor`; `@etherfold/fs` and `@etherfold/fs-cache`). Serialised so the documenter runs against the final package set rather than racing two deleters.

## Prompt

> Add a one-sentence `description` to every non-private package's `package.json` under `packages/*` and `platforms/*` in the `etherfold` monorepo, and a short, accurate `README.md` per package. Verify each summary against the actual source (and against the real consumers `wighawag/stratagems` and `wighawag/stratagems-snapshots`) before writing it — do not guess. Add a changeset for the `package.json` description changes. Docs/metadata only — no behaviour changes; do not commit without confirmation.
>
> FIRST, check this task against current reality (it is a launch snapshot and it HAS drifted before): `ls packages platforms` and read each manifest's `private` flag to derive the real set. Do NOT work from the role list below — it is stale, it names packages that are deleted or archived, and it omits about eleven that exist now. If a package it names is gone, that is expected; if a package you find is being deleted by `retire-the-js-object-processor-path` or `drop-filesystem-storage-and-rehome-the-fixture-loader`, skip it. If those two have NOT landed yet, STOP — this task is `blockedBy` them (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> Nothing in `archive/` gets a README or a description: it is outside the workspace globs and is not built, tested, versioned or published.
>
> Starting-point roles for the OLDEST packages only (verify every one against source, and expect to write far more than these): `@etherfold/core` = core engine (fetch logs, detect reorgs, drive a processor); `@etherfold/browser` = browser wrapper (reactive stores, IndexedDB persistence, auto-indexing, live reconfigure); `etherfold` (the CLI, bin `etherfold`) = run a processor over a source and write state (one-shot); `@etherfold/utils` = shared helpers (context/source hashing, filenames). The newer families — `@etherfold/server`, `@etherfold/state-store` and its four backends plus the conformance suite, `@etherfold/processor-entities`, `@etherfold/processor-sqlite`, `@etherfold/fetcher-host`, and `platforms/*` — have no prior guidance; read `CONTEXT.md`'s glossary for each one's role before writing it.

## Decisions

**`etherfold` stops publishing the repo's root README; the CLI now has its own committed one.** `packages/cli/package.json`'s `prepack` copied `../../README.md` into the package and `.gitignore` listed `/packages/cli/README.md` as generated, so the CLI's npm page described the monorepo and documented none of its flags, and any README I wrote there would have been overwritten at pack time. I changed `prepack` to copy only the LICENSE and removed the ignore entry (the LICENSE mirroring is untouched). Alternatives considered: leave the CLI as the one package with no README of its own (fails the acceptance criterion), or commit a README that `prepack` silently replaces (worse than either). Touches the publish path, so `work/tasks/ready/publish-etherfold-and-deprecate-old-names.md` should expect `packages/cli/README.md` to be a source file now.

**The private Worker host got a README too.** Criterion 1 is explicitly about non-private packages, but criterion 2 says "every KEPT package", so I read `platforms/cf-worker` as in scope and wrote one that opens by saying it is a deployable and not a library, never published. No description was added or changed for either private package (both already had one). The alternative was to skip it, which would leave the one package where D1's limits are legitimately named undocumented.

**I corrected one EXISTING description rather than only filling the gaps.** `@etherfold/state-store-sqlite` called itself a "Versioned-row state store for `@etherfold/core`", but it depends on `@etherfold/state-store`, `remote-sql` and `named-logs` and on nothing else, and `test/no-platform-leakage.test.ts` asserts that; naming core there inverts ADR-0016's direction. It now says "behind the `@etherfold/state-store` seam". This puts a package outside the missing-description set into the changeset (a `patch`), which is why it is called out rather than done quietly.
