---
title: 'A crashed `do spec:<slug>` leaves a tasking lock that no dorfl verb can release, so recovery needs manual ref surgery'
slug: a-crashed-spec-tasking-run-leaves-a-lock-no-verb-can-release
observed: 2026-09-03
source: 'hit while tasking spec:one-command-runs-the-whole-pipeline; the tasking agent died on a model-API `Connection error.` and the lock outlived it'
---

`dorfl do spec:<slug>` takes `refs/dorfl/lock/spec-<slug>` (`action: task`, `state: active`). When the tasking agent dies without surfacing (here: `Agent failed tasking '...' (Connection error.)`, an environmental model-API failure), the lock survives the process and every retry refuses with `'spec-<slug>' is already locked (held by another). Back off.`

**There is no verb to release it.** `dorfl requeue <slug>` is task-only: against a spec slug it answers `'<slug>' has no held per-item lock on origin — nothing to requeue`, because it looks for `refs/dorfl/lock/task-<slug>`. `dorfl gc` reaps worktrees, not locks, and reports `0 reaped` here because an isolated tasking run that died before producing output leaves no worktree. So the documented escalation ladder (requeue → `--reconcile` → `--reset`) has no rung for this state, and the only way forward is `git push origin :refs/dorfl/lock/spec-<slug>` by hand, which is exactly the tree-less lock release requeue performs for a task.

Worth noting how safe the manual release actually is in this case, because that is what makes the missing verb an ergonomics gap rather than a data-loss risk: a crashed tasking run has no work branch and lands nothing, so releasing the lock discards nothing. The check before doing it is just that the lock's `since` matches the dead run and no `dorfl` process is alive.

Two shapes a fix could take, neither decided here: teach `requeue` to resolve `spec-<slug>` as well as `task-<slug>` (the release mechanism is identical), or have `do spec:` release its own lock on an agent failure the way a failed build surfaces and releases. The second is better if a tasking crash should be as recoverable as a build crash; the first is smaller.

Not fixed here: it is dorfl's own surface, not this repo's, and it was hit while driving an unrelated spec.
