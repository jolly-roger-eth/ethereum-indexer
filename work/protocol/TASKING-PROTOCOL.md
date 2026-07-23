# TASKING-PROTOCOL

The **tasking discipline** the autonomous runner invokes by name on a spec in `work/specs/ready/` to decompose it into independently-grabbable, file-based work tasks (tracer-bullet vertical tasks). The runner spawns a fresh-context agent and tells it to "run the tasking protocol"; that agent reads THIS doc and applies its standard.

This is one of the runner-invoked protocol disciplines (alongside `CLAIM-PROTOCOL.md`, `REVIEW-PROTOCOL.md`, and `SURFACE-PROTOCOL.md`): the protocol describes how work is AUTHORED (`WORK-CONTRACT.md`, the templates), CLAIMED and BUILT (`CLAIM-PROTOCOL.md`, the `verify` floor), JUDGED BEFORE LANDING (`REVIEW-PROTOCOL.md`), has its OPEN QUESTIONS SURFACED (`SURFACE-PROTOCOL.md`), and — between spec and buildable task — TASKED (this doc). It is in-band in every set-up repo, never host-specific. (The human-facing pointer is `skills/to-task/SKILL.md`; the standard lives here.)

> This doc is **protocol-native**: it assumes the repo uses the `work/` contract. Every bare "WORK-CONTRACT" / "CLAIM-PROTOCOL" mention below refers to `work/protocol/<doc>` in the repo under work.

You **emit task files; you do not act on them** — see [Git protocol](#git-protocol). Committing them, moving the spec, claiming any of them is the caller's job (the runner, on the agent path; a human, on the no-runner path). This discipline is the _decomposition_, not the disposition.

## When to use vs. not

- **Use** when tasking a `work/specs/ready/<slug>.md`, a design doc, or a plan into grabbable units for solo-with-agents (incl. parallel) work.
- **Don't** use to _write_ the spec (that's a separate step — `to-spec`) or to _claim/run_ a task (that's the runner: `dorfl claim`/`do`/`complete`, or the `drive-tasks` conductor). Don't introduce a shared index file or a status field — status is the folder (see `WORK-CONTRACT.md`).

## Process

### 1. Locate / confirm the source

Work from a `work/specs/ready/<slug>.md`, a design doc, or the conversation context. If the source is a path, read it fully. The `work/` folder lives **inside the target project repo** (versioned with its code).

### 2. Explore the codebase (if not already)

Task titles and descriptions use the project's domain glossary. Respect ADRs / findings in the area you're touching.

**Check the spec against reality first (drift = a needs-attention signal).** A spec is a launch snapshot and may have DRIFTED from what has since landed (`tasks/done/`, ADRs, sibling tasks). Before tasking, verify its assumptions still hold. If it has drifted such that tasking it as-is would emit tasks built on a false premise, do NOT task it: set `needsAnswers: true` on the spec with the discrepancy in its body (or fix a small certain factual error first). See WORK-CONTRACT.md "Drift is a needs-attention signal". Never emit tasks from a stale spec.

### 2a. Task the spec ATOMICALLY, or SPLIT it, or REFRAME it as an EXPLORATION — NEVER task a subset

**A spec is tasked ATOMICALLY at its own scope: EVERY user story in it becomes a task now, or NONE does.** There is no "partially tasked" state — tasked-ness is RESIDENCE in `work/specs/tasked/` (the folder is the sole signal, WORK-CONTRACT.md "The spec lifecycle"), and a spec is only there iff ALL of it was tasked. Before you draft any tasks, run this **combined decision procedure** over the spec's user stories (the three branches are exhaustive — every spec resolves to exactly one):

1. **Every story build-taskable now?** A story is build-taskable when it is a committed direction, with no unanswered question gating it, AND you actually know HOW to build it (a vertical tracer-bullet task would be real, not fiction). If EVERY story clears, task the whole spec atomically (proceed to §3).
2. **Part gated / deferred / unanswered (mixed confidence tiers)?** A story that needs an unanswered question resolved, or is "direction, not commitment" (a gated-on-open-questions milestone, a "beyond v0" wishlist), is NOT taskable now. If SOME stories are build-taskable and others are gated, the spec is MIS-SCOPED: **STOP. Do NOT task the confident subset.** SPLIT the spec (below).
3. **The WHOLE thing too big / too uncertain to build-task, even after splitting?** If you do not yet KNOW how to build it — the approach is unproven, the seam is unvalidated, a load-bearing library/fork is unpicked — then build tasks written now would be FICTION, and splitting only yields smaller specs that STILL are not confidently buildable. **STOP. Do NOT write speculative build tasks.** REFRAME the spec as an EXPLORATION spec (below).

**The split (branch 2).** Carve the spec into (a) a fully-build-taskable spec whose stories are ALL committed-and-answerable, and (b) a separate spec for the gated/deferred remainder, grouped logically. Task (a) atomically; leave (b) in `work/specs/ready/` with its open questions and `needsAnswers: true`. Where (b) depends on (a), add `taskedAfter: [<a-slug>]` to (b) so the ordering is recorded (atomicity is WITHIN a spec; cross-spec ORDER stays expressed by `taskedAfter:` — §3b). Authoring a spec whose stories span multiple confidence tiers is the mis-scope the `to-spec` skill's right-sizing check tries to catch UP FRONT; if it reached tasking un-split, splitting it here is the last line of defence. (If a split PIECE is itself too-big/uncertain, that piece takes branch 3.)

**The exploration reframe (branch 3).** A too-big/uncertain spec's honest atomically-taskable form is an **EXPLORATION spec**, NOT a smaller build spec. This is a first-class SPEC KIND (see ADR `exploration-vs-build-spec-kinds`), distinguished by its definition of DONE:

- A **build spec**'s "done" = the capability is SHIPPED (tasked atomically as vertical build tasks — the existing model).
- An **exploration spec**'s "done" = CONFIDENCE + a de-risked, sliced BUILD PLAN. Its stories are "reach confidence" stories, not "deliver the capability" stories: pin the seam/interface, spike the risky part on the NARROWEST real case, resolve the open questions into decisions, and emit the build plan. THAT is atomically taskable (a handful of "pin interface X", "spike Y on one case", "evaluate-and-recommend Z", "emit the build plan" tasks). The capability BUILD then becomes a FOLLOW-ON build spec, written AFTER the exploration says "yes, this way, and here is how" (ordered via `taskedAfter:` from the follow-on to the exploration).

The spike/pin/evaluate tasks an exploration emits ARE throwaway-code-that-answers-a-question in the sense of the `prototype` skill — reuse that vocabulary (a spike is a prototype scoped to one question on the narrowest real case; the ANSWER is the deliverable, captured into the build plan / an ADR, not the code). Do NOT invent a parallel spike vocabulary, and do NOT add a new folder or state: an exploration spec is STILL just a spec in `work/specs/`, tasked atomically like any other. The reframe is what stops a too-big BUILD ambition from ballooning into an un-taskable build spec that then gets partially tasked (the branch-2 failure) or tasked as fiction (the branch-3 failure).

**Why forbid the subset.** Tasking a confident subset and papering the rest over in prose FEELS like progress, but it silently commits the project to a SEQUENCING decision (build the easy part first) that should be made deliberately at the split, not by default. The prose note it forces ("the rest is NOT tasked") is exactly the half-state the binary folder taxonomy cannot represent — the signal that the spec was mis-scoped. The anti-pattern to recognise: a single spec mixing a committed "v0" milestone with a gated "beyond v0" direction behind open questions (see ADR `tasking-is-atomic-or-split-no-partial-tasked-state`); a related anti-pattern is a decade-scale "grow the whole capability" build spec whose approach is unproven — that one is branch 3, an exploration reframe.

**How the two paths enforce it.** The AUTO-tasker gate is already whole-spec: it refuses a spec that is `needsAnswers`/`humanOnly`, so a spec with any gated story (branch 2) or unresolved approach (branch 3, which carries open questions) is never auto-tasked — that whole-spec refusal IS the atomicity guarantee on the agent path. The HUMAN `to-task` path is UNBOUND by that gate, so this decision procedure is what makes the rule symmetric: a human must NOT task a subset (branch 2) and must NOT write fictional build tasks (branch 3) and move the spec to `tasked/` — split or reframe first.

### 3. Draft vertical tasks

Each task is a **tracer bullet** — a thin vertical path through ALL layers end-to-end, not a horizontal cross-section of one layer.

- Each task delivers a narrow but COMPLETE path (schema → logic → API/UI → tests).
- A completed task is demoable/verifiable on its own.
- Prefer many thin tasks over few thick ones.
- Set the **two gate axes** ONLY where they apply (both default to OMITTED on most tasks): **`humanOnly: true`** = NEVER-for-agents BY NATURE (the NARROW DECIDED axis — secrets/release/security; survives even in the pool `work/tasks/ready/`); **`needsAnswers: true`** = unresolved questions block autonomous work (the DISCOVERED axis — list the questions in the task body). Omitted on either means "undeclared"; whether an agent may then auto-build is the _repo's_ `autoBuild` policy. Mark `blockedBy` for ordering. See `WORK-CONTRACT.md` for the two-axis semantics, the predicate, and the `autoBuild` precedence.
  - **A task's `humanOnly` is decided from the nature of BUILDING THAT TASK — never inherited from the spec.** Evaluate each task on its own merits (does _building it_ genuinely need to be done by a human BY NATURE — secrets handling, release pipeline, hard security boundary, an AGENTS.md prohibition?), AS IF the spec's `humanOnly` field did not exist. (The two flags are disjoint — see §3b.)
  - **Do NOT stamp `humanOnly` to mean "a human should REVIEW this before the agent builds it"** — that is the POSITION's job, not the flag's. The runner BIRTHS tasks STAGED in `work/tasks/backlog/` (not eligible); a human promotes the approved ones into the pool `work/tasks/ready/`. Review-first is encoded by the staging position; `humanOnly` is reserved for the rare never-by-nature case. (See WORK-CONTRACT.md "Task `humanOnly` is NARROW".)
  - **Do NOT be shy about `needsAnswers` — when genuinely unsure, FLAG, don't guess.** `needsAnswers` is cheap (a human clears it in seconds) and a confidently-underspecified task is expensive (an agent builds the wrong thing, convincingly). Defects concentrate in TASKING far more than in implementation: an ambiguous premise, an unresolved design fork, a "reuse X" where X's shape is unverified, or a seam you _assume_ exists — each is a `needsAnswers` with the open question written in the body, NOT a guess dressed as a spec. The asymmetry is the whole point: a false `needsAnswers` costs one human glance; a false confidence ships wrong-but-compiling work.
- **Prefer file-orthogonal tasks to minimise merge conflicts.** `blockedBy` encodes logical ordering, but two independent tasks that edit the SAME files will conflict when the second integrates after the first. Parallel agents make this real. So: split along file/module boundaries where you can; and when two tasks are known to touch the same module, add a `blockedBy` to **serialize** them even if there's no strict logical dependency. The runner only rebases-or-surfaces conflicts (it never auto-resolves), so avoiding them at tasking time is the cheap win.

### 3a. Wide refactors are the EXCEPTION to vertical slicing (expand → migrate → contract)

Most work slices vertically (§3). A **wide refactor** does not, and forcing it to is the failure mode this subsection exists to stop. A wide refactor is one mechanical change — rename a shared symbol or a column, retype a pervasive identifier, cut a vocabulary over — whose **blast radius** fans across the whole codebase, so a single edit breaks thousands of call sites at once and **no vertical tracer-bullet task can land green on its own**. Sequence it as **expand → migrate → contract** instead:

- **Expand** (one task): add the NEW form BESIDE the old so nothing breaks yet. Nothing is removed; the gate stays green because every existing caller still resolves.
- **Migrate** (one task PER batch, each `blockedBy` the expand task): move call sites onto the new form in batches sized by blast radius — per package, per directory, per module. Each batch is its own task and stays green because the old form still exists. Split batches file-orthogonally (§3's merge-conflict rule) so parallel agents don't collide.
- **Contract** (one task, `blockedBy` EVERY migrate batch): delete the old form once no caller remains. It cannot start until every migrate batch is done — that is what its `blockedBy` fan-in encodes.

**A KEY / folder rename task MUST ground its blast-radius claim against the actual code** — do NOT assert "every call site references the key, never a raw string" without grepping first, because when the key is a typed string literal (`as const satisfies WorkFolderKey` or the equivalent) renaming the key IS a hard TypeScript break at every call site, and those call-site literal updates MUST be scoped into the migrate batch, not deferred.

**When even the batches cannot stay green alone** (the change is so entangled that an individual batch can't pass the gate in isolation), keep the same expand → migrate → contract shape but let the batches share a common **integration point**: task each batch onto the work-branch discipline the runner already uses, and add a final **integrate-and-verify** task `blockedBy` all of them where green is promised — green is guaranteed only at that fan-in, not batch-by-batch. Prefer the plain green-batch-by-batch form; reach for the shared-integration form only when a batch genuinely cannot be made to pass alone.

The test for "is this a wide refactor?" is whether a single mechanical edit breaks the gate across many call sites at once such that no thin vertical path can be green. If yes, use this sequence; if a normal vertical slice CAN be green, it is not a wide refactor — slice it vertically (§3).

### 3b. Spec gate vs task gate are DISJOINT + honour cross-spec `taskedAfter`

- **`humanOnly` on a spec and `humanOnly` on a task are DISJOINT — they gate different verbs and DO NOT flow into each other.**
  - **Spec `humanOnly`** gates _tasking_: its ONLY effect is that an agent may not **auto-task** that spec (even where the repo's `autoTask` policy is on); a human must drive the decomposition. That is its entire meaning.
  - **Task `humanOnly`** gates _building_: it is decided per task from the nature of building that task (see §3), independently.
  - There is **NO inheritance, NO propagation, and NOT EVEN A HINT** from the spec flag to the task flags. A `humanOnly: true` spec can produce entirely agent-buildable tasks; an un-flagged spec can produce some `humanOnly` tasks. When setting a task's gate, ignore the spec's `humanOnly` entirely.
  - Likewise **`needsAnswers`**: on a spec it blocks auto-tasking until the questions are answered; on a task it blocks auto-building. Set a task's `needsAnswers` only when _that task_ has unresolved questions (list them in its body) — not because the spec had open questions (a spec with open questions should be resolved BEFORE tasking, not task-inherited).
  - (A spec's body may still _describe_ which areas are judgement-heavy — use that as ordinary domain input when reasoning about a task's own build-nature, the same as any other spec prose; it is not a flag-setting shortcut.)
- **`taskedAfter` (cross-spec order).** If this spec has `taskedAfter: [other-spec]`, those specs must already be TASKED (their tasks exist) before you task this one — so this spec's tasks can reference the real slugs of those specs' tasks in `blockedBy`. (The auto-tasker enforces this; a human may task anyway but must then know the blocker slugs.) If a needed blocker spec is not yet tasked, task it first or record the dependency and stop.

### 4. Quiz the user — OR (no human present) do a confidence check

**If a human is present** (the normal interactive path): present the breakdown as a numbered list — Title, the two gate axes, Blocked-by, and (if the source has them) which user stories it covers. Ask: granularity right? dependencies right? merge/split any? gates correct? Iterate until approved.

**If NO human is present** (an agent auto-tasking in CI): step 4 is replaced by a **confidence check**, because there is no one to quiz. Do NOT emit guessed tasks. The source spec should already be clear (the auto-tasker only runs on a spec that is not `humanOnly` and not `needsAnswers`). If, while tasking, ANY of {granularity, dependency order, a gate, a seam} is genuinely unresolved by the spec/ADR, do not guess: either set `needsAnswers: true` (with the open questions in the body) on the specific uncertain task, or — if the whole decomposition is unclear — stop and route the spec to needs-attention with the questions, rather than emitting a wrongly-cut task. Only emit tasks you would have gotten the human to approve.

### 5. Write the task files

For each approved task, write `work/tasks/backlog/<slug>.md` using `work/protocol/task-template.md`. Create `work/` and `work/tasks/backlog/` lazily if absent. One file per task. Use a content-derived slug, never a counter. Fill `blockedBy` with the slugs of blocking tasks, and set the **required `spec`** field to the slug of the source `work/specs/ready/<slug>.md` (so `covers` story numbers are unambiguous — see `WORK-CONTRACT.md`).

### 6. Trim the spec to its durable framing (one-time)

The spec is a launch snapshot (see the `to-spec` skill). Now that the work is tasked, the spec's **technical detail is redundant** (it lives in the tasks) and is the part that would otherwise go stale. Do a ONE-TIME trim:

- The tasks now own _what to build_ (Implementation/Testing detail) — remove those sections from the spec.
- Any **durable rationale** worth keeping (the _why_ of a decision) is RELOCATED to an ADR (`docs/adr/<slug>.md`), not deleted.
- The spec settles to its durable framing: Problem / Solution / User Stories / Out of Scope (+ its launch-snapshot banner). Leave a one-line pointer that detail moved to tasks/ADRs.
- **Move the spec to `work/specs/tasked/`** to record that it has been tasked: `git mv work/specs/<src>/<slug>.md work/specs/tasked/<slug>.md`, where `<src>` is the spec's CURRENT non-pool resting position. (Precondition: the spec was tasked ATOMICALLY — every story became a task, per §2a — whether it was a BUILD spec or an EXPLORATION spec; both move atomically. `specs/tasked/` residence means the WHOLE spec was tasked; moving a subset-tasked spec here is the partial-tasking wart §2a forbids.) — `ready` on the runner/dorfl path, but `proposed` on the human-driven path (a human MAY task a spec straight from `specs/proposed/` without first promoting it to `ready/`; doing so is deliberate — staging keeps it out of the auto-tasking pool so CI cannot race the human, and a forced `proposed → ready` pre-move would re-open exactly that race). The DESTINATION is always `tasked/` regardless of source. Transforming a spec into tasks MUST move it: residence in `work/specs/tasked/` IS tasked-ness (the build-machine `tasks/done/` analogue for specs, the sole signal); a tasked spec left in `proposed/`/`ready/` both lies about its state and stays auto-taskable (CI could re-fan-out). Do NOT add a `tasked:` frontmatter marker; the folder is the source of truth. (On the dorfl path `do spec:<slug>` performs this move itself as part of its runner-owned integration commit; this manual step is for the human-driven, no-lock tasking path.)

This is a hand-off transition, not ongoing maintenance — after this single trim the spec is stable because the stale-prone part was relocated, not because it is kept in sync. (Nothing is lost: detail → tasks; rationale → ADR.)

## Git protocol

Do NOT commit/push — leave the work for the caller to inspect/integrate. The one exception is the spec `specs/<ready|proposed>/ → specs/tasked/` relocation above, which is a `git mv` (so it is staged as a rename); leave every other new/edited file unstaged. Report the exact paths written (and the trimmed + relocated spec).

When the runner spawns you on the agent tasking path, you EDIT files only — write the task files under the STAGING folder, trim the spec — and the RUNNER owns every git-state transition (it commits the produced tasks, releases the tasking lock, and moves the spec into `work/specs/tasked/`). Do not stage, commit, push, or move any files yourself. The runner integrates the tasking transition through the shared band (`--propose` PR / `--merge` main) honouring the caller's flags.

## The emitted task shape (mirrors `work/protocol/task-template.md`)

Each emitted task file is a markdown document with YAML frontmatter, BORN STAGED in `work/tasks/backlog/<slug>.md`. The shape's enforced source of truth is the frontmatter parser code (`parseFrontmatter`) and the templated body in `work/protocol/task-template.md`; this section DESCRIBES it in prose so the spawned agent emits files the parser and the runner read identically.

### Required frontmatter fields

- **`title:`** — a short, human-readable title for the task (one line).
- **`slug:`** — the URL-safe content-derived slug; matches the filename `<slug>.md`. Never a counter.
- **`spec:`** — the slug of the source `work/specs/ready/<spec>.md` this task derives from. REQUIRED when `covers:` is non-empty; OMITTED only on a self-contained chore/refactor (with `covers: []`). Disambiguates `covers:` story numbers.
- **`blockedBy:`** — a YAML inline list of slugs that must reach `work/tasks/done/` first; `[]` means startable now.

### Optional frontmatter axes (omit when undeclared)

- **`humanOnly: true`** — gate axis 1 (DECIDED, NARROW): NEVER-for-agents BY NATURE (secrets / release / security / an `AGENTS.md` prohibition). Survives even in the pool `work/tasks/ready/`. OMIT when the task is agent-buildable — "review this before the agent builds" is the POSITION's job (the task is BIRTHED in `work/tasks/backlog/`), NOT `humanOnly`'s.
- **`needsAnswers: true`** — gate axis 2 (DISCOVERED): open questions block autonomous work. List the questions under an `## Open questions` heading in the body. OMIT when the task launches fully resolved.
- **`covers:`** — an inline list of user-story numbers within `spec:` this task covers; `[]` (or omitted) means no specific story coverage.
- **`issue:`** — the GitHub issue number an `intake`-emitted task was transformed from. Carried only when the task is the direct closer for an issue (mutually exclusive with `spec:` carrying the closure via the spec).

### Body sections

- **`## What to build`** — a concise description of the vertical task — the end-to-end behaviour (a thin path through every layer: schema → logic → API/UI → tests), NOT a layer-by-layer implementation plan. Avoid specific file paths / code snippets (they go stale).
- **`## Acceptance criteria`** — a bullet list of verifiable / demoable criteria, ending with the test-coverage line and (where applicable) the shared-write isolation rule from `WORK-CONTRACT.md`.
- **`## Blocked by`** — prose mirror of the frontmatter `blockedBy:`; `None — can start immediately.` when `blockedBy: []`.
- **`## Prompt`** — self-contained instructions to paste into a fresh agent context: an agent must be able to start from THIS FILE ALONE. State the goal, the relevant domain vocabulary, where to look (by module/concept, not brittle paths), the seams to test at, and what "done" means. Reference any constraining ADRs / findings.
- **`## Open questions`** — present iff `needsAnswers: true`; lists the unresolved questions blocking autonomous build. Stripped by the apply rung on full resolution.

### Placement rule

The tasker ALWAYS writes emitted task files to `work/tasks/backlog/` (the STAGING folder). The pool `work/tasks/ready/` is the agent-eligible pool the runner owns the promotion into; a write outside the staging folder is dropped by the runner-deterministic placement resolver. The agent never self-places into the pool.

## The on-disk contract

The full `work/` layout, slug rules, and frontmatter are in `work/protocol/WORK-CONTRACT.md`. The claim/lifecycle protocol these files are designed to support (consumed by the runner — `dorfl claim`/`do`/`complete`) is in `work/protocol/CLAIM-PROTOCOL.md` — read it so the files you emit are claim-ready, but this discipline does not itself claim or run tasks.
