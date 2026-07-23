# Claim protocol (consumed by the runner — `dorfl claim`/`do`/`complete`)

This documents how a `work/tasks/ready/<slug>.md` item is **atomically claimed** by one agent (human or autonomous) when several may try at once. The tasking discipline does not perform claims — it only emits files in a shape this protocol can consume. The runner/lifecycle implements the steps here.

## The core idea: claim = acquiring the item's per-item LOCK (an atomic create-only ref push)

A claim **acquires the item's per-item lock** — a hidden `refs/dorfl/lock/<type>-<slug>` ref (`<type>` is `task`/`spec`) created by an ATOMIC create-only push (`--force-with-lease=<ref>:`, i.e. "succeed only if the ref is still absent"). Git's ref-update-on-push IS the compare-and-swap: the winner creates the ref; a concurrent acquirer for the SAME item finds it present and is rejected = **definitively lost, with NO retry budget** (a per-item ref only ever contends with another writer for that same item — a genuine conflict the loser should lose). The item's body STAYS in `work/tasks/ready/<slug>.md`; **claim writes NOTHING to `main`** (so an agent can claim even on a protected `main`).

The claimable predicate is **"the body is in the pool `tasks/ready/` on `main` AND no lock is held on its ref."**

**Separate the claim from the work.** Acquire the lock first (cheap, collision-detecting); do the work only after the lock is provably held.

## The arbiter: one serialization point for updating `main`

The atomicity comes from a **single repo that everyone treats as the integration point** (`origin`), whose ref update on push linearizes claims. It can be EITHER:

- **A remote remote** — e.g. GitHub. Bare by construction; works across machines; everyone (including the human) participates by pushing to it.
- **A local bare remote** — a `--bare` repo in a folder (e.g. `work.git`), reached via `file://`. Works fully offline. **Must be `--bare`** (you cannot work _in_ the arbiter: a non-bare repo with `main` checked out rejects pushes to `main`, and force-enabling that moves `main` under your working tree).

The protocol is **identical** for both — it targets a remote _by name_ (`<arbiter>`), not a hardcoded URL. Switching offline↔online is `git remote set-url <arbiter> <url>` (or adding a second remote); the claim steps do not change.

> **Consequence the human must accept:** you participate like an agent — you reach `main` via push (ff / `pull --rebase` then push), NOT via unsynchronized local commits onto a checked-out `main` that is also the arbiter. The arbiter ref and a working `main` you hand-commit to cannot be the same ref. This is mild, good hygiene, and is what keeps the claim guarantee intact for everyone.
>
> **WARNING — reconcile by REBASE, never a plain `git pull` merge.** A merge does NOT re-run `verify` on the reconciled tree, so a clean merge can hide a semantically-broken result. If your push is rejected non-fast-forward: `git pull --rebase`, then re-run `verify` on the rebased tree BEFORE pushing. (The runner path enforces this automatically as the land invariant below; on the human path it is on you — the human path is deliberately lighter, but the invariant is the same.)

### Offline setup (local bare arbiter), once

```sh
# create the bare arbiter next to (not inside) your working clone
git clone --bare /path/to/project /path/to/project-work.git   # or: git init --bare
# in each working clone, point an `arbiter` remote at it
git remote add arbiter file:///path/to/project-work.git
```

When back online, repoint: `git remote set-url arbiter <github-url>` (or push the bare repo's `main` up). Same protocol throughout.

## The command: `dorfl claim` / `do`

These steps are implemented (and verified against real git, including a truly simultaneous two-agent race) by the runner — so a human or agent does not hand-run the dance:

```sh
dorfl claim <slug> [--arbiter <remote>] [--by <who>] [--dry-run]
```

Exit codes: `0` claimed · `2` not claimable (not in the pool, or the lock is already held = lost) · `1` usage/env error. The acquire is self-arbitrating (no contended-retry class — a per-item lock never falsely contends). The steps it performs:

## Claim steps

```
CLAIM (acquire the per-item lock; collision-detecting, no body move):
  1. fetch the lock refs from <arbiter> (refs/dorfl/lock/*)
  2. confirm the body is still in the pool: work/tasks/ready/<slug>.md on <arbiter>/main
  3. build a PARENTLESS lock-entry commit (action: implement, state: active
     — the SOLE `LockState`, post `retire-stuck-lock-state`; holder/since)
     with plumbing — never touches the working tree/HEAD
  4. push it create-only to refs/dorfl/lock/<type>-<slug>   (<type> = task/spec)
     with --force-with-lease=<ref>:   (the EMPTY expected value = "ref must be absent")
     ├─ ACCEPTED  -> the lock is atomically yours (the body stays in tasks/ready/;
     |              NOTHING was written to main).
     └─ REJECTED  -> the ref already exists: another writer holds this SAME item's
                    lock. You LOST, definitively (exit 2). No retry budget — pick a
                    DIFFERENT pool item. (holder/since are readable on the lock entry
                    via `dorfl status`.)
     # who/when rides the lock entry, not a frontmatter field (no claimed_by/claimed_at).

WORK (only after the lock is held):
  5. git switch -c work/<type>-<slug> <arbiter>/main   # the body is still in tasks/ready/ on main
     (use a dedicated worktree/clone for isolation when running in parallel)
  6. do the work; tests green.
  7a. SUCCESS path — the runner, at integration, lands the DURABLE move on main:
        git mv work/tasks/ready/<slug>.md work/tasks/done/<slug>.md
      committed together with the work (completed-task message, see below), then
      RELEASES the lock (delete the ref). Order: durable main-move FIRST, lock
      release SECOND — a crash between leaves a done-on-main item with a stale lock,
      and recovery treats the main record as authoritative and clears it.
  7b. BOUNCE path — if it could NOT complete (red gate, rebase/merge conflict, task
      too ambiguous to build, timeout, rejected review): the runner performs ONE
      crash-safe transition — write / update work/questions/<type>-<slug>.md (a
      SidecarKind: 'stuck' sidecar) with the reason (+ any agent-surfaced questions),
      set needsAnswers: true on the item body on main, RELEASE the lock — and SAVES
      the recoverable work as a wip commit on the kept work/<type>-<slug> branch
      (pushed to the arbiter). The body already rests in tasks/ready/. A human
      ANSWERS the sidecar; the apply rung drains it (resolve = continue,
      resolve+resolveReset = discard the work/<type>-<slug> branch and continue,
      dispose = terminal git mv per regime). Ordering: surface-on-main FIRST,
      release SECOND (main-authoritative on recovery). The `stuck` LOCK STATE
      is RETIRED; `LockState` is 'active' only. (The build agent never touches the
      lock or main — the runner owns both.)
  8. integrate to <arbiter>/main as normal (PR on GitHub, or ff/rebase push offline).
```

> The durable `tasks/ready → tasks/done` / `specs/ready → specs/tasked` / `tasks/ready → tasks/cancelled` moves (and the bounce surface: write `work/questions/<type>-<slug>.md` + flip `needsAnswers`) are the writes to the shared `main` ref, so THEY keep a small retrying CAS; the per-item LOCK acquire/release never does (it is self-arbitrating). The two substrates are independent; the only lock that can outlive its leg is a genuine crash-orphan `active`, which `main`-authoritative recovery clears (post `retire-stuck-lock-state`, the pre-retirement `done + stuck` co-existence case no longer arises — a bounce releases the lock cleanly).

## The land invariant — rebase + re-verify + advance

Step 7a's durable `main` move (the LAND) is the mode-agnostic primitive: **fetch current `main` → rebase the work branch onto it → re-run `verify` (and review) on the rebased tree → advance.** A lost CAS or a moved-`main` between gate and push INVALIDATES any prior green and re-arms the gate (re-rebase, re-`verify`, retry — never a `--force`, never an auto-resolved conflict). Merge mode runs it inline at the serialised land; propose mode runs it at the human checkpoint (the propose PR is merged only after the rebased tip re-verifies green). Human review is ADDITIVE (intent/design/security), NEVER a substitute for the re-verify on the rebased tree. The durable _why_ — and the floor/ceiling gradient from bare git to a capable host — lives in ADR `land-primitive-rebase-reverify-advance`.

## The prompt handed to the work agent (the `## Prompt` wrapper)

When a human or an autonomous runner dispatches an agent to do the WORK phase, the agent is given a small, constant **wrapper** around the task's own `## Prompt` section. The wrapper is the same every time except the slug; an autonomous runner emits it deterministically. The task file is the spec; the wrapper just frames it and draws the line around git.

```
You are completing one work task in this repo. It has already been claimed for
you (its per-item lock is held) and lives at work/tasks/ready/<slug>.md — read that
file fully; it is your complete spec (What to build, Acceptance criteria, Prompt).
Also read its source spec (the task's `spec:` field, at work/specs/ready/<spec>.md)
for context.

<!-- if promptGuidance.testFirst -->
Implement it to satisfy every Acceptance criterion. At the agreed seam, write
the failing test BEFORE the production code, matching the repo's house style;
this is guidance, not a gate — the `verify` step still decides pass/fail.
<!-- else -->
Implement it to satisfy every Acceptance criterion. TDD where the task asks for
it; match the repo's house style.
<!-- /if -->

If you NOTICE a problem OUTSIDE this task's scope (a flaky test, a latent bug, a
suspicious behaviour), do NOT fix it and do NOT expand your scope. Instead drop a
short, dated note in work/notes/observations/<short-slug>.md (one or two sentences
is enough — what you saw and where) so the signal is captured, then carry on with
your task. (work/notes/observations/ is an append-only capture bucket; anyone, you
included, may add to it. Writing such a NOTE is the one exception to the "no file
changes outside your task" rule below — it is a note, not work.)

If the TASK ITSELF is the problem — it is ambiguous, under-specified, rests on a
premise that no longer matches the code/ADRs (it has DRIFTED), or hides an
unresolved design decision — do NOT guess and build on it. STOP and report
specifically what is unclear or contradicted (and where), so a human can resolve it
(the runner routes the item to needs-attention). Do not be shy about this: a
confident build on a wrong/ambiguous premise produces wrong-but-compiling work that
is far more expensive than a question. Building exactly what a flawed task says is
NOT success.

To STOP, make NO source change and end your final report with this EXACT
machine-readable block (the runner detects it, routes the item to
needs-attention with your reason VERBATIM, and SKIPS the gate + review — so put
the specific drift report INSIDE it):

=== TASK-STOP ===
<the specific reason: which premises are false, where, and a suggested re-scope>
=== END TASK-STOP ===

The decision bar between "resolve and proceed" and "STOP" / "record a decision":
A genuinely small, certain, SELF-CONTAINED factual gap you can resolve from the
code itself (it affects nothing outside this task), resolve and proceed silently.
But a choice that touches ANOTHER command/flag/task, introduces a new
ERROR/REFUSAL, or sets a USER-VISIBLE DEFAULT is a DESIGN decision, NOT a small
factual gap — do NOT bury it in code. If it is load-bearing AND hard to reverse,
STOP (above). Otherwise PROCEED but RECORD it DURABLY and LINK it from the done
record, one entry per decision — what you chose + why + the alternative(s) you
considered + what it touches (which other flag/command/task). Any durable home
is acceptable: a module JSDoc at the choice site (best when there is an obvious
code site the decision governs), a "## Decisions" block in the done record / PR
body (the recommended fallback when there is no natural code site), or a dated
observation note under work/notes/observations/. Whichever home you pick, LINK
it from the done record so it is discoverable. This does NOT stop the build; it
makes the choice visible so the reviewer + the human can ratify or reverse it.
The bar is "would another task / a user / a reviewer be surprised this was
decided here?" — if yes, record it. A real ambiguity or stale premise, STOP.

COHERENCE CHECK (before you introduce a new concept). Consistency and coherence
with the system's existing LANGUAGE is a first-class quality. Before you add a new
flag / config key / status / verb / named concept, check it against the project's
`CONTEXT.md` glossary + the ADRs + the existing code: (1) does the name already
MEAN something — are you silently re-meaning it or making it mean two things? (2)
is the concept at the RIGHT LAYER (e.g. a policy gate on the autonomous-selection
step vs the explicit verb a human typed)? (3) does it DUPLICATE/overlap an existing
concept you should reuse or rename instead of forking? If a new concept conflicts
with, re-means, or duplicates an existing one — or sits at the wrong layer — that is
NOT a "small factual gap": STOP if it is load-bearing/hard-to-reverse, else RECORD
it durably per the rule above (JSDoc at the choice site, a `## Decisions` entry
in the done record, or an observation note — linked from the done record), noting
what concept, what it overlaps, why your placement. This is
the prevention half of the review's conceptual-coherence lens — a muddled concept
that compiles is far more expensive than the question, because every later artifact
that reuses the muddled term inherits the debt.

Do NOT perform any git operations on THIS repo — do not stage, commit, push, or
move any files between work/ folders, and do not touch the item's lock ref or its
body at work/tasks/ready/<slug>.md. The runner (or human) owns every git-state
transition (the durable main-moves AND the per-item lock acquire/release/amend).
(Your TESTS may freely create and operate on their OWN throwaway git repos — that
is expected.)

If this task produces a DURABLE, REUSABLE artifact — a patch, a build/measurement
script, a captured measurement, a diagram — write it to docs/spikes/<slug>/ (a
STABLE path that does NOT move when the task lands) and REFERENCE it from the task
record / finding / ADR. Do NOT create a <slug>/ sidecar folder next to a task or
spec (work/tasks/<slug>/, work/specs/<slug>/): only notes/* items may carry a
co-located sidecar, because tasks and specs FLOW through status folders and a
co-located sidecar gets STRANDED on the ready→done move (one item split across two
folders — WORK-CONTRACT rule 8). Transient BUILD SCRATCH (source trees, GBs of
objects) belongs OUTSIDE the repo entirely.

Leave a CLEAN working tree — only the changes this task intends. The runner
commits everything untracked (`git add -A`), so any scratch, debug, or
runtime-artifact file you or your tools created would otherwise be swept into the
commit. Before you stop, delete such stray untracked files, or add them to
.gitignore if they legitimately belong ignored. This is NOT git work: deleting an
untracked file or editing .gitignore is producing clean WORK, like writing source
— the "no git" rule above (no stage/commit/push/move) still holds.

This repo may declare STANDING per-change conventions — things EVERY change must do
regardless of the task (e.g. add a release/changelog entry, regenerate a file,
update a manifest). They live in the repo's conventions doc: read CONTEXT.md (its
`## Conventions` section) and, if present, AGENTS.md, and satisfy any that apply to
your change. Several are ENFORCED by the `verify` gate, so skipping one makes the
gate go red at LAND time — a bounce — even though your task's own code is correct.
The classic case: a change that touched a package but added no changeset entry
(the gate reports the changed package has no changeset). When in doubt, follow the
conventions doc; it is the repo's source of truth for these standing rules.

When the acceptance criteria are met and the repo's build/test/format checks are
green, STOP and report what you did. The runner handles the durable `git mv` of the
body tasks/ready/ -> work/tasks/done/, the completion commit, the lock release, and
integration.
```

The "no git" line is **in-band** in the prompt (not delegated to a host config like a global `AGENTS.md`): a portable runner cannot assume the target machine has any such rule, so the boundary travels with the prompt. This keeps the acceptance-test gate authoritative (the agent can't commit/merge around it) and the runner the single owner of git state.

## Completed-task commit message

The commit that completes a task (the work + the `git mv` to `work/tasks/done/`) uses a consistent, greppable format so the lifecycle is visible in `git log` and an autonomous runner can author it deterministically:

```
<type>(<slug>): <task title or short summary>; done
```

- `<type>` follows conventional-commits (`feat`, `fix`, `docs`, `chore`, …); use `feat` for a task that adds behaviour.
- `<slug>` is the task slug (its `work/tasks/done/<slug>.md` basename).
- the trailing **`; done`** marks the durable `tasks/ready→tasks/done` transition landing in this commit (the claim itself has no `main` commit to mirror — it is a lock-ref acquire, not a folder move).

Example: `feat(scan): cross-repo eligible-work queue (read-only); done`

Keep it ONE commit (work + the `git mv`) so a task's completion is a single, atomic, revertable unit — just as the claim is a single commit.

## Why this prevents (not merely detects) double-claims

The rejected push is the rejection of the claim. Because the arbiter serializes ref updates, only one create-only push to `refs/dorfl/lock/<type>-<slug>` can win; all others are rejected atomically by `git receive-pack`'s ref lock. No lock server, no integrator process. `--force-with-lease` is a CAS against the expected old value (safe); `--force` would clobber and MUST NOT be used.

## Isolation for parallel agents

Run each agent's work in its **own clone or worktree** so on-disk code changes can't collide; conflicts then only surface at integration time (normal PR-style resolution), never as corrupted shared state. Clones-of-an-arbiter give fully independent object stores (best isolation); worktrees share one object store (save disk) — either is fine, but prefer separate clones when many agents run at once.
