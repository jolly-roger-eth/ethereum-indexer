---
title: 'A task that bounced once and was then rebuilt and MERGED leaves its bounce question on main, still asking to cancel a task that is now in done/'
slug: a-rebuilt-task-leaves-its-bounce-question-asking-to-cancel-a-merged-task
observed: 2026-09-03
source: 'hit while driving task:a-follower-replays-a-retraction-a-paused-writer-appended with the drive-tasks skill (dorfl 0.13.1): the first build died mid-investigation on an environmental model-API failure, the re-dispatch built it cleanly, and PR #59 merged. The sidecar the first run wrote is still on main. The residue is OBSERVED; dorfl behaviour on answering it has NOT been tested.'
---

`dorfl do task:<slug>` surfaces a **dispose-defaulted question** when the agent produces an empty diff:

```
>> The agent STOPPED building '<slug>' (empty diff); surfaced a dispose-defaulted question
   on origin/main and released the lock.
```

That writes `work/questions/task-<slug>.md`, whose Q1 is *"the agent produced no change … Cancel this item? [default: yes]"* with `allAnswered=false` in the sidecar header, and whose suggested default is `dispose (cancel this task → work/tasks/cancelled/, retained)`.

The bounce is deliberately surfaced rather than auto-requeued, and the reasoning in the sidecar is sound: *"'Nothing to do' is a non-deterministic LLM judgement"*, so it breaks an infinite re-run→re-judge loop. The gap is what happens on the OTHER branch of that fork. Answering the sidecar is only one way the state resolves; the other is that somebody disagrees with the agent, re-dispatches, and the task **succeeds**. Here the re-dispatch produced a full green build and merged as PR #59, so:

- `work/tasks/done/a-follower-replays-a-retraction-a-paused-writer-appended.md` — the task is DONE, and
- `work/questions/task-a-follower-replays-a-retraction-a-paused-writer-appended.md` — the question is still on `main`, still unanswered, still defaulting to **cancel this task**.

Nothing in the successful path clears it: the second `do` ran to `complete` and the PR merge did the done-move, and neither consults `work/questions/` for the item it just landed.

**Why this is worth a note rather than a shrug.** The residue is not inert — it is a pending instruction whose default is destructive, pointed at a task that has already shipped. Accepting the default (or an `advance`-class leg that processes `work/questions/` unattended, which is exactly the file-mediated contract that sidecar exists to feed) would try to `git mv` a body out of `work/tasks/done/` into `work/tasks/cancelled/`, for work that is merged on `main`. Whether dorfl actually performs that move against a done task, refuses it, or errors is **untested here** — that is the open question, not a claim.

It also quietly corrupts the board's readable state: `work/questions/` is meant to be the set of things awaiting a human, so a stale entry for finished work is a false positive in precisely the surface a human scans to find what is blocked.

Two shapes a fix could take, neither decided here: have `complete` (or the merge-time done-move) **retire the item's question sidecar** when the item lands, which is the narrow, obvious one and matches "the item reached its terminal, so its open questions are moot"; or have the question **carry the run identity** it was raised for, so an answer is scoped to that attempt and a later successful attempt strands nothing. The first is smaller and closes this case; the second is the more honest model if an item can bounce several times.

Related but distinct: `every-completed-task-leaves-its-lock-ref-reporting-in-progress` (lock refs outliving a done task, dorfl 0.13.1) and `a-crashed-spec-tasking-run-leaves-a-lock-no-verb-can-release` (a lock with no release verb). This one is not about locks — the lock here was released correctly by the surface commit, and `dorfl requeue` rightly answered *"has no held per-item lock on origin"*. It is the QUESTION artifact that outlives the item.

Not fixed here: it is dorfl's own lifecycle surface, not this repo's, and it was hit while driving an unrelated task.

## Update — it was not one instance, it was ALL FOUR

Before clearing anything I checked the rest of the directory against `work/tasks/done/`. **Every sidecar in `work/questions/` named a task that had already landed** — four for four:

| sidecar | bounce reason | task |
| --- | --- | --- |
| `task-a-follower-replays-a-retraction-a-paused-writer-appended` | empty diff (environmental, mid-investigation) | `done/` (PR #59) |
| `task-the-old-indexer-shape-is-deleted` | agent STOP on a false-premise acceptance criterion | `done/` |
| `task-the-one-shot-is-build-and-serve-is-only-the-read-tier` | `api_error`, then a conflicted rebase | `done/` |
| `task-the-stream-appends-in-segments-on-indexeddb` | `prepare (env-prep) failed (exit 127)` | `done/` |

So this is not "a rebuilt task strands its sidecar" — it is that **nothing ever drains a sidecar**, and the bucket has been silently accumulating since sidecars were introduced. The scale changes the reading: `work/questions/` is supposed to be the set of things awaiting a human, and it was a set of four things awaiting nobody, all defaulting to destructive dispositions against merged work.

The sharpest evidence is `task-the-stream-appends-in-segments-on-indexeddb`, which was **answered by a human in writing** and still sat there. Its answer reads, in part:

> OBSOLETE — already resolved; nothing to proceed with. The bounce was ENVIRONMENTAL … Recovery is complete … **Close this sidecar.**

The instruction to close it was written INTO the file and nothing acted on it. That rules out the gentler explanation that the drain only misses the rebuild path: the documented `resolve` rung ("clear `needsAnswers` + delete the sidecar") did not run even on a sidecar that was explicitly answered. Whatever drains these is either not wired to the human-answer path at all, or only runs inside a leg that these items never re-entered.

All four are deleted as of this note; git history is the archive, per the contract's deletion-only lifecycle for transient artifacts. The one with real content worth knowing about is `task-the-old-indexer-shape-is-deleted`, whose Q1 is a substantial agent analysis arguing two of that task's premises were already false (it names commit `9e2c66d` and the specific tests that already asserted the criterion it was asked to add). That reasoning is worth reading in `git show` if that task's history ever comes up again.

## Update — the instance is cleared, the signal is not

`work/questions/task-a-follower-replays-a-retraction-a-paused-writer-appended.md` has been deleted by hand, which is what `resolve` would have done had there been anything left to resolve: the task it named is merged and resting in `work/tasks/done/`, so neither `resolve` (clear `needsAnswers` + delete the sidecar) nor `dispose` (terminal `git mv`) describes the end state a successful REBUILD leaves behind. That is the gap this note is about, and deleting one stranded file does not close it.

This note therefore stays LIVE: the dorfl behaviour is unchanged, and the next task that bounces will strand its sidecar exactly the same way. Discharge it when dorfl retires an item's questions on landing (or scopes an answer to the attempt that raised it), not because these instances were tidied up.

Given the four-for-four rate, the fix shape suggested above should be read as the MINIMUM. "Retire the sidecar when the item reaches its terminal" closes the rebuild path; it does not by itself explain why an explicitly answered sidecar survived, which is the second, likelier-to-bite defect: an answer a human wrote is only as good as the rung that drains it, and here that rung did not run.
