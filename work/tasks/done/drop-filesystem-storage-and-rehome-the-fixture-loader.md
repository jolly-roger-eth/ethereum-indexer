---
title: 'Drop filesystem storage and the fs event cache, and rehome the fixture loader that was the only thing using them'
slug: drop-filesystem-storage-and-rehome-the-fixture-loader
blockedBy: []
covers: []
---

## What to build

Delete `@etherfold/fs` as a STORAGE package, **and `@etherfold/fs-cache` with it**. IndexedDB is the browser backend and SQLite is the server
backend; a filesystem keeper serves neither, and the one thing those packages are actually used for is a
test-fixture loader that belongs elsewhere.

**`@etherfold/fs-cache` is in scope, and it was previously unowned by ANY task or spec.** It is the
fs-backed event-log cache for the free-form path: 8 tracked files, a published name, and **ZERO
importers anywhere in `packages/*`, `platforms/*` or `examples/*`**. It fails the same test
`@etherfold/fs` fails, for the same reason, and it serves the path ADR-0037 retires. Re-run the grep
before deleting; if a consumer has appeared, STOP and surface it. Adding it here rather than minting
a second task is deliberate: it is the same judgement, the same substrate and the same changeset.

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
- [ ] `packages/fs-cache` is deleted the same way, after re-confirming it still has zero importers.
      Note it has no real test script (`echo "Error: no test specified"`), so a green `pnpm test`
      proves nothing about it either way — the grep is the evidence.
- [ ] The stratagems conformance workload still loads its fixtures and still runs.
- [ ] Ship a changeset covering the removal of BOTH published package names.
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

RECORD in a `## Decisions` block where `loadStreamFixture` went and why, and confirm the zero-importer
grep result for `@etherfold/fs-cache` at the time you ran it. Do NOT write the done record,
the commit message or the PR body.

---

### Claiming this task

```sh
dorfl claim drop-filesystem-storage-and-rehome-the-fixture-loader --arbiter origin
git fetch origin && git switch -c work/drop-filesystem-storage-and-rehome-the-fixture-loader origin/main
# on completion, in the work branch's PR/merge:
git mv work/tasks/ready/drop-filesystem-storage-and-rehome-the-fixture-loader.md work/tasks/done/drop-filesystem-storage-and-rehome-the-fixture-loader.md
```

## Decisions

- **Where `loadStreamFixture` went, and why.** It moved to `@etherfold/conformance-workload-stratagems` as `src/fixture-file.ts` (exported from `src/index.ts`), the task's stated obvious choice and the only consumer. It is deliberately NOT in `@etherfold/core`: core names no runtime and must not grow a `node:fs`/`node:zlib` dependency for a test-fixture loader. Alternative considered: core (rejected for exactly that reason); the CLI (rejected — the loader is test material, not a CLI capability).
- **`saveStreamFixture` moved with it, though the task named only `loadStreamFixture`.** The two halves share one file convention (gzip chosen by the `.gz` extension, indented by default), and `saveStreamFixture` has a real consumer: the spike's re-capture script, which is the documented way the committed fixtures are re-captured. Deleting it would have orphaned that path; keeping it in a deleted package was not an option. Alternative considered: deleting it and inlining ~12 lines into the capture script (rejected — duplicates the convention the fixtures' READMEs document).
- **The changeset criterion could not be satisfied as written; the removal is recorded as ADR-0041 instead.** The task asks to "ship a changeset covering the removal of BOTH published package names", but the repo forbids that form: `packages/core/test/pendingChangesets.test.ts` (landed 2026-08-23, before this task was promoted 2026-09-01) fails any pending changeset naming a package not in the workspace, and I verified empirically that a changeset naming `@etherfold/fs`/`@etherfold/fs-cache` makes both `pnpm test` and plain `pnpm changeset status` fail ("Found changeset … which is not in the workspace"). ADR-0014 already records that "changesets cannot express … the removal". Naming the only package that actually changed (`@etherfold/conformance-workload-stratagems`, `private` with `privatePackages: false`) would produce a changeset `changeset version` never consumes — a zombie of exactly the accumulated-stale-changesets shape that test and ADR-0014 exist to prevent — so I shipped no changeset and wrote the record where the repo puts removals: an ADR. The release-notes need is also vacuous: neither name was ever published, so no release ever ships them and no `npm deprecate` is owed. **This deliberately leaves acceptance criterion "Ship a changeset…" unmet; if a changeset-shaped artifact is nonetheless required, that is a human call** (the alternatives are weakening the gate test or flipping `privatePackages`, neither of which I would do unilaterally). Touches: the publish/release path and the gate.
- **The stale `'@etherfold/fs': patch` line was removed from the pending changeset `the-gate-does-not-assume-an-idle-machine.md`.** Forced, not chosen: with the package deleted, that pending release intent cannot be cut and `pnpm test` is red until the line goes (the exact staleness the pendingChangesets test documents). The changeset still names the 16 packages that genuinely gained the timeout config. Touches: that pending changeset only.
- **The five `docs/spikes/sqlite-in-the-browser/` scripts were rewired rather than left broken.** Four `run/*.ts` and `capture/capture-stratagems-base.mjs` imported the loader from `packages/fs/dist/index.js` by path — invisible to the task's name-based grep and not *new*, but they are a durable, re-runnable artifact and the capture script is the documented re-capture path for the workload's fixtures. They now import `packages/conformance-workload-stratagems/src/fixture-file.js` (the same tsx `.js`-specifier-onto-`.ts` pattern the spike already uses for the vendored oracle — verified working by loading the real base fixture through the new path). Consequence: the capture script now runs under `npx tsx` instead of plain `node` (its header, the spike's `package.json` and README updated). Alternative considered: leaving them broken with an observation note (rejected — a documented command silently failing is worse than a two-line rewiring).
- **Left alone, deliberately**: `archive/ethereum-indexer-server` (imports `@etherfold/fs-cache`; outside the workspace, not built or published); `docs/spikes/promotion-cost-of-a-two-label-stream/src/port-fs.ts` (a closed spike's self-contained exhibit whose comment "mirrors `packages/fs/src/utils/fs.ts`" is now historical); `CONTEXT.md` (its KeepState entry's "fs storage adapters" remains true — the CLI's own file keeper, `packages/cli/src/keepState.ts`, is untouched); ADRs and CHANGELOGs that mention the deleted names (historical records); `docs/reviews/todo-triage.md` (a dated review).
