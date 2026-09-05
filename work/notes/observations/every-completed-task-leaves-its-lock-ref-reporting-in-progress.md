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

## Update 2026-09-04 — still present on dorfl 0.13.2, and the count has grown from 19 to 26

The repo was updated from dorfl 0.13.1 to 0.13.2 (latest on npm at the time of writing) and this was re-checked immediately after. **It is unchanged.**

```
$ git ls-remote origin 'refs/dorfl/lock/*' | wc -l
26
```

All 26 name a task resting in `work/tasks/done/`: not one of them is a live claim, and the count is exactly the number of tasks built since the refs started accumulating. `dorfl status` still reports every one as `implement/active = in-progress`.

Two of the 26 were created TODAY, by builds that completed normally: `task-a-reconfigure-hashes-the-resolved-stream-config-everywhere` and `task-a-follower-replays-a-retraction-a-paused-writer-appended`. Both were driven with `do --isolated --allow-backlog`, both opened a PR, and the runner said in as many words that it was "keeping the per-item lock HELD (propose PR open; the work is not yet on main). It is released when the PR merges (reconciled against main)." Both PRs then squash-merged (#58, #59) and the refs are still there. So the release-on-merge step the runner promises is the part that does not happen, on the propose path, in the current version.

That is a sharper statement of the cause than this note originally had, and it narrows where a fix would go: not in `do`'s claim/complete path, which behaves as described, but in whatever is supposed to reconcile a held lock against a merged PR. There is no `run` daemon on this machine to do it, and the repo is not registered (`dorfl remote add . --local`), which the note above already suspected. Whether registration alone would reconcile them is still UNTESTED.

Still not fixed here, for the reasons above, and now for one more: the 26 refs are the evidence, and they are the only record of which builds this happened to.

## Update 2026-09-04 — FIXED in dorfl 0.13.3, and this note is now dischargeable

0.13.3 closes it, in the shape this note and its sibling both argued for: reconcile on read rather than a merge hook.

`dorfl status` no longer reports these as in flight. They now appear under their own accurate heading, which states the reasoning inline:

```
Completed, lock not yet released (26; item is at rest on main, so this is NOT in flight)
```

The resolver behind it (`cwd-section.ts`) is READ-ONLY by default: stale locks are classified against `<arbiter>/main` and reported via `staleLocks`, and nothing on the arbiter is touched. Two further pieces complete it:

- **`dorfl status --reconcile-locks`** is an opt-in WRITE that RELEASES the locks whose item is terminal on `<arbiter>/main`, reporting them via `reconciledLocks`. That is the manual drain lever for a backlog like this one.
- **The claim path now sweeps on every unit of work**, which is the part that matters: the docstring says the lever is "not needed for routine convergence" precisely because of it. So the leak does not recur going forward, and the 26 here are historical residue rather than an ongoing accumulation.

What was NOT done, correctly: the refs are not deleted behind the operator's back on a read. A stale lock is reported truthfully and drained deliberately, which is the same read-only-by-default posture `prune` and `compact` take elsewhere in this tree.

The 26 refs are still present as of this note, deliberately: they were kept as the evidence corpus for exactly this fix. That rationale is now spent, so they can be drained with the lever above whenever the operator wants.
