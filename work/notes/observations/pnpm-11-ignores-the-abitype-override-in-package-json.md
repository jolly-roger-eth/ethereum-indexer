---
title: 'pnpm 11 ignores the root `pnpm.overrides`, so a fresh install installs two abitypes'
slug: pnpm-11-ignores-the-abitype-override-in-package-json
observed: 2026-08-24
source: 'task:promote-stratagems-conformance-workload, while installing to run the gate'
---

`pnpm install` on pnpm 11.15.1 prints `The "pnpm" field in package.json is no longer read by pnpm. The following keys were ignored: "pnpm.overrides"` and then resolves `abitype` to 1.2.3 inside viem while `@etherfold/core` keeps 1.2.4, which is exactly the two-copies situation the root override exists to prevent; `packages/core/test/abitypeIdentity.test.ts` goes red on the fresh install alone, with no source change. The settings moved to `pnpm-workspace.yaml` (adding `overrides: {abitype: 1.2.4}` there restores the single copy and leaves the committed lockfile byte-identical, which is how this worktree was made green again), but moving them is a repo-wide dependency decision and not this task's, so nothing here was changed.

Second, smaller thing seen in the same place: `pnpm install` currently fails its supply-chain policy check because `dorfl@0.13.1` (added by the previous commit, `chore(deps): dorfl 0.13.1`) is newer than the `minimumReleaseAge` cutoff. That one heals itself once the release is a day old.
