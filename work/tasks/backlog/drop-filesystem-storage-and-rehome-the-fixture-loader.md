---
title: 'Drop filesystem storage, and rehome the fixture loader that was the only thing using it'
slug: drop-filesystem-storage-and-rehome-the-fixture-loader
blockedBy: []
covers: []
---

## What to build

Delete `@etherfold/fs` as a STORAGE package. IndexedDB is the browser backend and SQLite is the server
backend; a filesystem keeper serves neither, and the one thing that package is actually used for is a
test-fixture loader that belongs elsewhere.

**The evidence, checked rather than assumed:**

- `keepStreamOnFile` has **ZERO callers** — one grep hit in the whole repo, its own definition.
- The **CLI does not use this package at all**. It has its own `packages/cli/src/keepState.ts` with an
  `atomicWriteFileSync` (openSync + fsyncSync + renameSync), which is unrelated code that happens to
  also touch files.
- The **only** import of `@etherfold/fs` anywhere is
  `packages/conformance-workload-stratagems/src/fixtures.ts` taking `loadStreamFixture`.

So this is not a deprecation with a migration path; it is deleting a package with one consumer and
moving that consumer's dependency.

**Why it is worth doing rather than leaving dormant.** It is not the code, it is the DESIGN PULL: a
filesystem keeper has no transaction, which is what produced the open tail, the seal threshold, the
strip, temp-file-plus-rename and the torn-segment recovery — machinery that shaped the shared stream
helper for a substrate with no users. Leaving the package present invites the next author to serve it
again.

**OPFS is not a reason to keep it.** The plausible future file-shaped keeper is the browser's Origin
Private File System, and OPFS is `FileSystemSyncAccessHandle`, not `node:fs`. Nothing in this package
would be reused. What transfers is the substrate-neutral segment logic in the core helper, which is
exactly why that helper exists — see `work/notes/ideas/an-opfs-stream-keeper-could-be-a-real-append.md`.

## Acceptance criteria

- [ ] `loadStreamFixture` (and the gzip-aware read it does) has a new home that does not require a
      storage package. `@etherfold/conformance-workload-stratagems` is the only consumer, so moving it
      there is the obvious choice; putting it in core would add a `node:fs` dependency to a package
      that names no runtime, so do NOT do that without saying why in `## Decisions`.
- [ ] `packages/fs` is deleted, with its workspace references removed, and nothing else in the repo
      imports it.
- [ ] The stratagems conformance workload still loads its fixtures and still runs.
- [ ] Ship a changeset covering the removal of a published package name.
- [ ] `pnpm build && pnpm typecheck && pnpm test` green.

## Blocked by

- None — can start immediately. It does NOT block the stream work: the one remaining stream task is
  IndexedDB-only and does not touch this package.

## Prompt

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): re-run
the greps above. If a NEW consumer of `@etherfold/fs` has appeared since this was written, STOP and
surface that rather than deleting under it.

**Where to look.** `packages/fs/src` is the package (`utils/fs.ts` is the whole storage helper;
`storage/stream/OnFile.ts` is the unused keeper; `storage/stream/Fixture.ts` is the loader that has a
real consumer). `packages/conformance-workload-stratagems/src/fixtures.ts` is that consumer.

**Note what this task is NOT.** It is not a statement that file-shaped storage is forever wrong; it is
that a `node:fs` keeper serves no supported runtime today. The seam it would attach to is unchanged
and an OPFS keeper could be written against it later without this package existing.

RECORD in a `## Decisions` block where `loadStreamFixture` went and why. Do NOT write the done record,
the commit message or the PR body.

---

### Claiming this task

```sh
dorfl claim drop-filesystem-storage-and-rehome-the-fixture-loader --arbiter origin
git fetch origin && git switch -c work/drop-filesystem-storage-and-rehome-the-fixture-loader origin/main
# on completion, in the work branch's PR/merge:
git mv work/tasks/ready/drop-filesystem-storage-and-rehome-the-fixture-loader.md work/tasks/done/drop-filesystem-storage-and-rehome-the-fixture-loader.md
```
