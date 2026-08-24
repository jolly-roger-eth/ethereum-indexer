---
title: 'Every completed task leaves its lock ref behind, so `dorfl status` reports 19 merged tasks as in-progress'
slug: every-completed-task-leaves-its-lock-ref-reporting-in-progress
observed: 2026-08-24
source: 'noticed while driving task:backend-neutral-entity-event-processor, task:index-in-the-browser-with-a-chosen-backend and task:bootstrap-an-entity-store-from-a-snapshot with the drive-tasks skill (dorfl 0.13.1). The ref/state listing below is observed; the CAUSE is inferred from the status output and has NOT been confirmed against dorfl source.'
---

`git ls-remote origin 'refs/dorfl/lock/*'` returns 19 refs. Every one of them names a task that is already resting in `work/tasks/done/` on `main`, and every one reports `implement/active = in-progress` in `dorfl status`:

```
task-a-read-that-cannot-be-served-refuses          task-portable-mutation-context-seam
task-backend-neutral-entity-event-processor        task-promote-stratagems-conformance-workload
task-bootstrap-an-entity-store-from-a-snapshot     task-prune-versions-outside-retention-window
task-bounded-id-prefix-listing                     task-query-surface-from-entity-declarations
task-clear-the-release-path-and-archive-the-old-names  task-retention-capability-and-refusal
task-declaration-legality-is-one-rule-everywhere   task-state-store-conformance-suite
task-entity-identifier-sql-keyword                 task-three-small-gaps-left-by-the-seam-drive
task-index-in-the-browser-with-a-chosen-backend    task-typecheck-tests-in-the-acceptance-gate
task-indexeddb-row-backend-browser-default         task-light-store-behind-the-seam
task-one-processor-cli-and-split-server
```

The lock commit message is literally `lock: task-<slug> (implement/active)`.

This is not specific to the three tasks driven today: 16 of the 19 predate that drive and correspond to PRs #12 through #16 and earlier, all long merged. So it has been accumulating for the whole life of the board.

## Why it looks like a reconciliation that never fires

On completing a `--propose` build, `dorfl do` says explicitly:

```
keeping the per-item lock HELD (propose PR open; the work is not yet on main).
It is released when the PR merges (reconciled against main).
```

The PRs did merge, and the bodies did land in `tasks/done/`, so the release condition is satisfied and the reconciliation is what has not happened. `dorfl status` for this repo also prints:

```
no arbiter remote configured — divergence vs arbiter unknown.
This repo participates (0 backlog items) but is NOT registered — `run`/`scan` across
machines won't see it until `dorfl remote add . --local` (or `remote add <its-url>`).
```

The inference — **unconfirmed** — is that the merge-time reconciliation is tied to the registered/arbiter-remote path, and this repo drives through `--isolated` against `origin` inferred from cwd, which is enough to BUILD (all three builds today resolved the mirror and pushed fine) but apparently not enough to reap the lock afterwards. Someone should check that against dorfl's source rather than trusting this paragraph.

## What it costs

Nothing yet, which is why it has gone unnoticed for 19 tasks. The bodies are in `done/`, the branches are merged and deleted, and the durable state on `main` is correct — the contract puts status in the FOLDER, and the folder is right. The lock refs are the transient view only.

Where it will bite:

- **`dorfl status` / `scan` are now misleading noise for this repo**: the "In progress" section lists every task ever built and nothing that is actually running, so a human (or an `advance`/`run` leg) reading it cannot tell a live claim from a dead one. That is the view whose entire job is answering "what is in flight".
- **A re-claim of any of those slugs** — `requeue`, a rebuild after a revert, or a future task reusing a slug — meets a held lock it has to be talked out of.
- It masks a REAL stuck lock. `task-promote-stratagems-conformance-workload` genuinely was stuck at one point (commit cbd9c43, `surface ... (stuck): prepare (env-prep) failed`) and was then completed in #16. Today it is indistinguishable from the other 18.

## Not fixed here

Deliberately: clearing lock refs is a git-state mutation on the arbiter, it is repo-wide rather than belonging to any task driven today, and the right fix is probably configuring the arbiter remote / registering the repo (`dorfl remote add . --local`) so reconciliation fires on its own, rather than hand-deleting 19 refs and leaving the cause in place. Hand-deleting would also destroy the one piece of evidence a diagnosis needs.
