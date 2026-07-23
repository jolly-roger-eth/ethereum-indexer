# The `work/` on-disk contract

The shared contract between the task PRODUCER (the tasking discipline) and the task CONSUMER (the runner / lifecycle). It is designed to be **conflict-safe for parallel agents**: every rule below avoids merge conflicts and lost updates.

## Location

`work/` lives **inside the target project repo**, versioned with that repo's code. Tasks reference that repo's code; work happens in clones/worktrees of that repo.

## Layout — three REGIME umbrellas: notes/ (capture) + tasks/ (build) + specs/ (spec lifecycle), plus questions/ + protocol/

The top level groups every tree by its GOVERNANCE REGIME, so a reader can tell what a folder MEANS without reading further: `notes/` are capture buckets (they do not flow), `tasks/` is the build board (status = folder), `specs/` is the spec lifecycle (status = folder), and `questions/` + `protocol/` are standalone top-level surfaces.

```
work/
  # ---- notes/ — CAPTURE BUCKETS: NOT status-governed; they do NOT flow/move ----
  notes/
    ideas/<slug>.md        # proposed, pre-spec ideas — EDITABLE, deletable
    observations/<slug>.md # spotted, unverified signals — APPEND-ONLY, deletable
    findings/<slug>.md     # VERIFIED external/domain ground truth — durable

  # ---- tasks/ — the BUILD board: DURABLE status IS the folder; FLOW via `git mv` on `main` ----
  # Task lifecycle (staging → pool → terminal):
  tasks/
    backlog/<slug>.md      # STAGING: a task not yet admitted to the agent pool —
                           #   review-first admission AND the human-control position
                           #   (untrusted output lands here; a human promotes, OR drives
                           #   it IN PLACE via `do --allow-backlog` — never promote-then-drive)
    ready/<slug>.md        # the AGENT POOL: built tasks, grabbable items eligible to claim
    done/<slug>.md         # completed (moved here durably on `main` at integration)
    cancelled/<slug>.md    # the task regime's "won't-proceed" terminal (lightweight ADR);
                           #   the REASON (out-of-scope / superseded by <x> / duplicate /
                           #   abandoned) lives in the item body as `reason:`

  # ---- specs/ — the SPEC lifecycle: DURABLE status IS the folder; FLOW via `git mv` on `main` ----
  # Spec lifecycle (staging → pool → tasked / terminal):
  specs/
    proposed/<slug>.md     # STAGING: a spec not yet admitted to the auto-task pool —
                           #   review-first admission AND the human-control position
                           #   (untrusted/agent-authored output lands here; a human promotes,
                           #   OR tasks it IN PLACE — TASKING-PROTOCOL.md §6 — never promote-then-task)
    ready/<slug>.md        # the AUTO-TASK POOL: specs eligible to be tasked into tasks
    tasked/<slug>.md       # TASKED, resting specs — the spec `done/` analogue; the
                           #   SOURCE OF TRUTH for tasked-ness (see note below)
    dropped/<slug>.md      # the spec regime's "won't-proceed" terminal (REASON in the body)

  # ---- questions/ — the "what needs me?" queue, kept TOP-LEVEL (NOT under notes/) ----
  questions/<slug>.md      # surfaced blockers a human must look at — glance-able top-level

  # ---- protocol/ — the protocol reference docs ----
  protocol/                # WORK-CONTRACT.md, CLAIM-PROTOCOL.md, the templates, VERSION

  # ---- TRANSIENT IN-FLIGHT HOLDS: NOT on `main` — on per-item lock refs ----
  # `in-progress` (claimed/building), `tasking` (a spec being tasked), and
  # `advancing` (a tick holding an item) are NOT `main` folders. They collapse
  # into ONE per-item lock on a hidden `refs/dorfl/lock/<type>-<slug>` ref:
  # `action: implement|task|advance` (+ holder/since). `LockState` is
  # `'active'` ONLY (the `stuck` lock state was retired — see `needs-attention`
  # below and the 2026-07-14 addendum to ADR `ledger-status-on-per-item-lock-refs`).
  # The lock is the IN-FLIGHT ACTIVE HOLD only: real CAS mutual-exclusion for a
  # running claim/build/task/advance, always released at end-of-leg (success OR
  # bounce). A bounced "needs a human" item is surfaced on `main` (see below), not
  # parked on the lock. A human reads in-flight holds via `dorfl status`/`scan`
  # (which read the lock refs) and reads parked-on-`main` items by `ls`-ing
  # `work/questions/` / `work/tasks/ready/`.
```

> **The two won't-proceed terminals use DIFFERENT words ON PURPOSE — `tasks/cancelled/` vs `specs/dropped/` — and it is a CORRECTNESS rule, not taste.** A task and a spec can share a slug, and a single shared bare-slug terminal (`work/dropped/<slug>.md`) would COLLIDE a dropped task and a dropped spec on the same path. Namespacing each regime's terminal under its own umbrella (`tasks/cancelled/<slug>.md`, `specs/dropped/<slug>.md`) gives each its own slug space, so the collision cannot happen. A dropped OBSERVATION needs no terminal — notes leave by deletion. (Every reader keys by `(umbrella, slug)`, never a bare slug, so `tasks/ready/foo.md` and `specs/ready/foo.md` legitimately co-exist.)

### Three governance regimes + the substrate split (the key distinctions)

- **Work items' DURABLE positions are the folder** (specs: `specs/proposed`/`specs/ready`/`specs/tasked`/`specs/dropped`; tasks: `tasks/backlog`/`tasks/ready`/`tasks/done`/`tasks/cancelled`): **status = the folder**, transitions are `git mv` on `main`, each has one destiny. This is the conflict-safe core for the durable resting records. The ONLY moves ever made on `main` are these durable resting transitions: `tasks/ready → tasks/done`, `specs/ready → specs/tasked`, `tasks/ready → tasks/cancelled` (and `specs/ready → specs/dropped`). The per-regime terminals (`tasks/cancelled/`, `specs/dropped/`) are where an item that will not proceed for ANY reason (superseded, out-of-scope, duplicate, abandoned/obsolete) rests, with the REASON in the body (`reason:` line). They are deliberately NAMED differently per regime — see the slug-collision note above.
- **Transient status + locks are NOT on `main`** — they are per-item lock refs. `in-progress`/`needs-attention`/`tasking`/`advancing` are lock-ref state, not folders. A work branch cut from `main` therefore inherits NO transient status, so a continue/rebase is a plain rebase with nothing to drop. Eligibility/dependency resolution stay OFFLINE on `main` (`blockedBy → tasks/done/`, `taskedAfter → specs/tasked/`); only the operational "what's in flight" view (`status`/`scan`) reads the lock refs.
- **Capture buckets** (`notes/ideas`/`notes/observations`/`notes/findings`) are **NOT work items** and are **exempt from status = folder** — they are _notes_, not units of work. They do not move through statuses; they sit in their bucket, and the folder is the inbox (`ls work/notes/observations/` = the live signal list). They leave only by **deletion** (git history is the archive). A note may _spawn_ work (a task, an idea, an ADR) created independently — the note does not "become" or `git mv` into that work; it is simply deleted once it is no longer a useful signal. **Operational discharge test for a promoted note:** a note is dischargeable (deletable) the moment a **self-contained** artifact carries its signal — verify the spawned task/ADR actually contains the mechanism + fix shape (not just a back-pointer), then delete the note. Do NOT keep it until the spawned work lands in `tasks/done/`: a note stops being a live _signal_ the moment it is captured into actionable work, not when that work completes. If the spawned artifact is NOT self-contained, the bug is the artifact (fix it to carry the signal), not a reason to keep the note.
  - **Deletion-on-apply is the SANCTIONED discharge — it is human-AUTHORED, so the capture-bucket rule below — a note "leaves the inbox **by deletion** the moment it stops being a live signal", a judgement only a human is authorised to make — does NOT bar it.** When the `advance` apply rung acts on a note whose question the human has ANSWERED, a decision agent reads that answer + the source note and emits a VERDICT, and the discharge DELETES the note in the SAME commit: a mint verdict (a new task / spec / ADR) rides the note's `git rm` in the same atomic commit as the new artifact's create; a delete-source verdict (the answer means "throw it away") is a standalone, revertible delete commit with the reason in the commit message. The cheap throw-away has a DIRECT path too — the human, the `answer-questions` skill, or the `dorfl` delete verb removes the source + its sidecar straight, no engine round-trip. Either way this is the human's ANSWER being EXECUTED, not the agent unilaterally destroying a live signal — that capture-bucket rule (the agent never deletes a live signal on its own judgement) only ever barred deleting an **un-answered** note; the human's answer IS the authorisation to delete. There is therefore **no `triaged:` / `needsAnswers:false` resting state** for a discharged note and **no `## Recommended: delete` recommend-and-retain hand-off** — a discharged note leaves the inbox, it does not rest there stamped "resolved". (Work ITEMS still leave via a terminal FOLDER, never by deletion; only notes discharge by deletion.)

> **Every capture-bucket note and every work item has a DIRECTION and a LIVENESS — never manufacture a backward artifact to look compliant.** Forward artifacts — a `tasks/ready/` task, an _open_ `notes/observations/` signal — describe work that is **pending or currently-signalled**, never the past. So: work that is **already done** does NOT get a task or observation back-filled to narrate it (a `tasks/ready/` task with pre-ticked acceptance criteria is a changelog wearing a spec's shape); completed work is recorded as a `tasks/done/` record landed _with_ the code plus the commit message, owned by whoever does the git transition. And a captured note is LIVE: it leaves the inbox **by deletion** the moment it stops being a live signal — a note annotated "resolved" and kept is a contradiction (there is no `resolved` status; discharge it by deleting it, its lasting product being the task/ADR/commit it spawned). This binds an agent invoked **outside** the runner too: building directly is fine when asked, but do not retroactively mint forward artifacts for it afterward.

### The three capture buckets (different by polarity + mutability)

| Bucket | What | Mutability | Leaves by |
| --- | --- | --- | --- |
| `notes/ideas/` | a _proposed_, pre-spec opportunity ("we might want to build this") | **editable** (refine the proposal in place) | deletion (when built/abandoned) |
| `notes/observations/` | an _observed, unverified_ signal ("I noticed something maybe wrong") | **append-only** (add `## Update` notes; don't rewrite what was seen) | deletion (when no longer a useful signal) |
| `notes/findings/` | _verified external/domain_ ground truth (a reverse-engineered protocol, an external API's real behaviour) | accumulates; durable | rarely — it is reference knowledge |

> **`findings/` is for EXTERNAL/DOMAIN ground truth, NOT internal post-mortems.** A finding is durable knowledge about a _world the software integrates with_ (e.g. a Bluetooth/hardware protocol we reverse-engineered, a third-party API's undocumented behaviour) — it accumulates, it does not "resolve". An _internal_ investigation (why a test flakes, a perf regression) is NOT a finding: it is a transient `notes/observations/` signal that drives a fix task and/or an ADR. **ADRs — the durable _why_ of OUR technical decisions — live in `docs/adr/`** (format: `ADR-FORMAT.md`, alongside this contract), never in `work/notes/findings/`. So: observation = "spotted, unverified"; finding = "verified external ground truth"; ADR = "what WE decided and why".
>
> **Every finding MUST carry a `source:` (provenance) — how, and how _currently_, the finding came to be believed.** A finding is only as true as the source it was derived from, so the source is what makes it _correctable_: if the source is later shown wrong (or stale), the finding can be revised and you can trace _why_ it was believed. There is deliberately **no separate `confidence:` field** — a bare confidence label is redundant at best and misleading at worst ("doc-verified" sounds authoritative until you learn the doc was last touched ten years ago). The honest signal lives IN a rich `source:` string: state _what_ the source is AND _how current_ it is, specifically enough that a reader can judge its weight themselves. Examples (weakest → strongest, by their own description):
>
> - `"derived from reading src/<the-integrating-module> @ <commit>"` — weakest: it assumes our code is correct, so the finding inherits any bug in it. (A code-derived finding describes the _external behaviour our code assumes_, NOT our code's internal shape — that is `CONTEXT.md`/`docs/`.)
> - `"<external API/spec> docs, retrieved 2026-06-09"` — a dated external authority (the date is what stops it silently going stale).
> - `"captured live API response 2026-06-09, trace in <path>"` — strongest.
> - `"told by maintainer @<name>, 2026-06"` / `"inferred from the test asserting it at <path>"` — whatever it actually was; write it plainly.
>
> Put `source:` in the finding's frontmatter (see below) and, when the provenance is non-obvious, expand on it in the body. A finding without a source is a `notes/observations/` signal, not a finding.

**For work items, DURABLE status is the folder a file lives in — never a frontmatter field.** Finishing / dropping / tasking-complete = moving the file between durable folders with `git mv` on `main`. This is what makes concurrent durable updates safe: two agents moving _different_ files never conflict. (Transient status — claimed/stuck/being-tasked — is NOT a folder move; it is a per-item lock ref, see above. Capture buckets are exempt too.)

### The spec lifecycle: `specs/ready/` (pool) → `specs/tasked/` on `main`; the tasking HOLD is a lock ref

A spec rests in `work/specs/ready/` (the auto-task pool) and, when tasked into tasks, moves durably to `work/specs/tasked/` on `main`. The **folder is the source of truth for tasked-ness**, exactly as `work/tasks/done/` is for tasks. Re-tasking a reshaped spec is `work/specs/tasked/ → work/specs/ready/` (reopen-to-ready, mirroring `tasks/done/ → tasks/ready/`).

**The tasking HOLD is a per-item lock, NOT a `work/tasking/` folder.** Tasking a spec acquires the unified per-item lock with `action: task` on `refs/dorfl/lock/spec-<slug>` — a create-only ref push that is self-arbitrating (winner creates it; a concurrent tasker loses the same CAS definitively, no retry budget), so a spec is never double-tasked. The spec body STAYS in `work/specs/ready/` while held (it does not move to a `tasking/` folder). On a **successful tasking** the release performs the durable `work/specs/ready/ → work/specs/tasked/` move on `main` in the SAME runner-owned commit that emits the `tasks/` items, then releases the lock. On an **aborted / unclear** tasking the lock is released with no `main` move (the spec already rests in `specs/ready/`), or the lock is marked `stuck` for a human.

- **Tasked-ness is RESIDENCE in `work/specs/tasked/` — the FOLDER, the SOLE signal.** There is no `tasked:` frontmatter marker; the folder is canonical. A spec whose lock is held `action: task` is _being tasked right now_; a spec in `specs/tasked/` _has been tasked_; a spec in `specs/ready/` is _to-task_.
- **Edit a spec when its tasking-lock is NOT held.** While the tasking lock is held the spec is mid-tasking; edit it before tasking starts or after it lands (in `specs/ready/` or `specs/tasked/`), not while the lock is held. (A human on a stale local checkout won't see the durable `git mv` until they fetch — the protocol guarantees no _silent corruption_, not no _human surprise_.)
- **Release fails loud on a concurrent edit (never a silent stale tasking).** If the held spec body was edited while the lock was held, the release detects it (the held content no longer matches the snapshot the lock took) and FAILS LOUD: the tasking is stale → re-task from the edited spec or mark the lock stuck. The release NEVER force-restores over the edit or emits tasks cut from a stale snapshot.
- **The human path needs no lock.** A human tasking locally with no agent running has no contention and may task on `main` directly — the lock is mandatory for the agent, optional for the human (parallel to "the runner never skips verify; the human may").

### Land = rebase + re-verify + advance (the durable-move invariant)

Every durable `main` move (a task's `tasks/ready → tasks/done`, a spec's `specs/ready → specs/tasked`, a `tasks/ready → tasks/cancelled`) is a LAND, and every land is the same mode-agnostic primitive: **fetch current `main` → rebase the work onto it → re-run `verify` (and review) on the rebased tree → advance.** A lost CAS / moved-`main` between gate and push INVALIDATES any prior green and re-arms the gate (re-rebase, re-`verify`, retry — never a `--force`, never an auto-resolved conflict). Merge mode runs it inline at the serialised land; propose mode runs it at the human checkpoint. Human review is ADDITIVE (intent/design/security), NEVER a substitute for the re-verify on the rebased tree. The durable _why_ — a clean `git` merge validates the AUTHORED context, never the LIVED context — lives in ADR `land-primitive-rebase-reverify-advance`.

### `needs-attention` — the post-claim "couldn't finish" state (surfaced on `main` as `needsAnswers:true` + a `stuck`-kind sidecar)

An item that was claimed and _attempted_ but could not complete is SURFACED ON `main` as a question sidecar instead of reaching `tasks/done/`. This is the single home for every "couldn't finish, a human must look" outcome — a failed acceptance gate (red tests), a rebase/merge conflict, a task the agent found too ambiguous to build, a timeout, or a rejected review. It is NOT a `main` folder move of the item, and (post `retire-stuck-lock-state`, spec `surface-stuck-as-questions-and-retire-stuck-lock-state`) it is NOT a lock state either. The bounce is ONE crash-safe transition: write / update `work/questions/<type>-<slug>.md` (a `stuck`-kind sidecar) with the reason (+ any agent-surfaced questions), set `needsAnswers: true` on the item body on `main`, then RELEASE the lock. The item body never moves (it rests in `tasks/ready/`, since claim does not relocate it). See the 2026-07-14 addendum to ADR `ledger-status-on-per-item-lock-refs`.

- **Who marks it:** the runner/human that owns the lock + `main` transitions — NOT the build agent (which never touches the lock ref or `main`). On a bounced job the runner writes the sidecar + flips `needsAnswers`, RELEASES the lock, and SAVES the recoverable work as a wip commit on the kept `work/<type>-<slug>` branch (pushed to the arbiter so it travels cross-machine).
- **Not claimable:** a `needsAnswers:true` item is `eligible:false` by construction, so it is not auto-picked; it IS visible — in `ls work/questions/`, in `git clone`, and in `dorfl status`/`scan`. `tasks/done/` on `main` and a `needsAnswers:true` `tasks/ready/` body cannot legitimately co-exist for the same slug (a bounce releases the lock cleanly; the two-substrate `done + stuck` co-existence case the pre-retirement lock had is gone).
- **Resolve / return path:** a human ANSWERS the sidecar; the existing apply rung drains the answer — `resolve` (continue: clear `needsAnswers` + delete the sidecar; the `work/<type>-<slug>` branch is left UNTOUCHED so the next claim continues from its tip), `resolve` + `resolveReset` (reset: delete the `work/<type>-<slug>` branch, then continue), or `dispose` (regime-polymorphic terminal: task → `git mv tasks/cancelled/`, spec → `git mv specs/dropped/`, observation → `git rm`). The direct human verbs `resume` / `requeue <slug>` / `release-lock` still work; they now target an in-flight or crash-orphan `active` lock, not a `stuck` lock. A crash-orphaned lock (the only class that can outlive a leg) is nameable and clearable via `release-lock <item>` (+ an orphan-lock report in `gc --ledger`); a lock whose entry name is NOT derivable from any current item-form (e.g. after a rename) is cleared via `release-lock --entry <literal>`, which `gc --ledger` surfaces the exact invocation for — no raw `git push origin --delete refs/dorfl/lock/…` needed. There is no liveness heartbeat and no auto-sweep (a human asserts a lock is dead).
- This is a _post-claim_ state. (A separate _pre-claim_ "not ready" state is the STAGING folder `tasks/backlog/` — the position gate — not this.)
- **Branch self-conflicts cannot occur by construction.** Because NO transient status lands on `main` (a bounce is a lock amend, not a `git mv`), a work branch cut from `main` inherits no `needs-attention`/`tasking`/`advancing` markers, so a continue/rebase is a PLAIN rebase with nothing to drop. A genuine content conflict between two real lines of development still aborts → the item is marked stuck.

### Drift is a needs-attention signal (check the doc against reality first)

A spec and a task are **launch snapshots** — they capture intent at creation and are deliberately NOT kept in sync (current truth lives in `docs/adr/` + the code in `tasks/done/`). So by the time you act on one, it MAY have **drifted**: a dependency landed differently than the doc assumed, an ADR superseded a decision the doc relies on, a sibling task changed the seam it builds against.

**Discipline (applies whenever you investigate / task / claim / build):** before acting, **check the doc against reality** — the code in `tasks/done/`, the relevant ADRs, and sibling tasks it depends on. If you find a discrepancy that would make you build/task against a false premise, that is a **needs-attention candidate — do NOT silently proceed on the stale spec.** Route it per the item's kind:

- **A TASK that contradicts current reality** → route to needs-attention (surface a `work/questions/task-<slug>.md` sidecar + set `needsAnswers: true` on the task body + release the lock) with the discrepancy as the reason (the same mechanism as a red gate), rather than building on a stale assumption. A human answers the sidecar; the apply rung dispatches (`resolve` → continue, `dispose` → `tasks/cancelled/`). The body already rests in `tasks/ready/`. (Building on a stale task produces wrong-but-compiling work — the worst outcome.)
- **A SPEC that has drifted** (before tasking) → do NOT task it as-is. Set `needsAnswers: true` on the spec with the discrepancy in its body (or, if it is a small factual correction you are certain of, fix the spec first), so the tasker never emits tasks from a stale spec. A human reconciles, clears the flag, then it is tasked.
- **A SPEC that has drifted AFTER it was TASKED** (a mechanism it assumed got retired, a sibling decision superseded it) → do **NOT** move it back to `specs/proposed/`. `specs/proposed/` is the untrusted-admission STAGING position; moving an already-tasked spec there falsely un-records a tasking that really happened and ORPHANS the tasks it already emitted (they still sit in `tasks/backlog`/`tasks/ready` carrying `spec:`/`covers:` linkage to a spec that now claims it was never tasked). Tasked-ness is RESIDENCE in `specs/tasked/` and must never be silently rewound. Instead, two honest mechanisms (use the lighter one that fits):
  - **Annotate in place (drifted, not yet re-decomposed).** Set `needsAnswers: true` on the spec **while it stays in `specs/tasked/`**, with the drift + what must be re-decomposed in its body, AND set `needsAnswers: true` on every emitted task that is now premised on the dead mechanism so no agent builds it. `needsAnswers: true` on a `specs/tasked/` spec is legal and means exactly _"tasked, but the spec has drifted — do not RE-task or rely on it until reconciled."_ The non-drifted emitted tasks are unaffected and stay promotable.
  - **Reopen to re-decompose (the sanctioned move).** When you are ready to re-task from the reconciled spec, use the existing reopen path `specs/tasked/ → specs/ready/` (mirroring `tasks/done/ → tasks/ready/`), reconcile the spec, clear `needsAnswers`, then re-task — which emits corrected tasks. Supersede the stale emitted tasks into `tasks/cancelled/` (reason: superseded by the re-task). There is NO `specs/tasked/ → specs/proposed/` transition.

The rule is symmetric: _a discrepancy between a doc and reality is not something to paper over — it is exactly the "a human must look" signal `needs-attention` (tasks) / `needsAnswers` (specs) exists to carry._ Cheap to honour, and it stops drift from silently propagating into built work.

## Conflict-safety rules (non-negotiable)

1. **One file per item.** Never put two work items in one file. Disjoint files merge trivially.
2. **No shared index / manifest.** Do not maintain a `work/INDEX.md`, `work/list.json`, or any file every item touches — it is a guaranteed conflict point. Derive lists on demand with `ls work/tasks/ready/` / `grep`. (A hand-maintained index just goes stale.)
3. **An empty lifecycle folder is OPTIONAL — absence means "empty", never "broken".** The folders in the layout above (`tasks/backlog`/`ready`/`done`/`cancelled`, `specs/proposed`/`ready`/`tasked`/`dropped`, the `notes/*` buckets) describe the POSITIONS an item MAY rest in, not directories that must all exist at rest. Git does not track empty directories, so a position with no items in it simply has no folder on disk, and a reader/conductor MUST treat a missing lifecycle folder as the empty set (e.g. no `specs/proposed/` ⇒ "nothing awaiting promotion"), NOT as a misconfigured tree. A folder is CREATED implicitly the first time an item lands in it (the `git mv`/write that places the item), and may VANISH again when its last item leaves. So: never fail, warn, or auto-create-as-a-fixup on a missing lifecycle folder; derive each position's contents on demand (rule 2) and let an empty position be a no-op. (`setup` may scaffold a starter set for ergonomics, but the contract does not REQUIRE their continued existence — emptiness and absence are the same state.)
4. **Status = location, not a field.** See above.
5. **Content-derived slugs, never counters.** Use a URL-safe slug from the title (e.g. "Historical store schema" → `historical-store-schema`). NO monotonic integer IDs — two agents would both grab "next = 43". A short hash or date prefix is fine if disambiguation is needed (`historical-store-schema` or `2026-06-03-historical-store-schema`).
6. **Dependencies by slug, read-only.** `blockedBy: [other-slug]` references other items; an item never writes another item's file. The blocker owns its own status (its folder).
7. **Claim state is the per-item LOCK, never a frontmatter field (and not a folder move).** Claiming an item acquires its per-item lock (`refs/dorfl/lock/<type>-<slug>`, `action: implement`) — a create-only ref push that is self-arbitrating (the loser is definitively told "lost", no retry budget); the body STAYS in `tasks/ready/` (claim writes nothing to `main`, so an agent can claim even on a protected `main`). The holder/since ride the lock entry; `git` (the ref + its parentless commit) holds the authoritative record. There is NO `claimed_by` / `claimed_at` frontmatter, and no `git mv` into an `in-progress/` folder — the claimable predicate is "in the pool `tasks/ready/` on `main` AND no lock held on its ref".
8. **A co-located `<slug>/` asset sidecar folder is for `notes/*` ONLY — tasks/specs use a STABLE `docs/spikes/<slug>/` home and REFERENCE it.** The item is ALWAYS the `<slug>.md` file (that is its identity and the only thing scanned). A `notes/*` note (`ideas/`/`observations/`/`findings/`) MAY carry companion resources — a `.patch`, a mockup image, a diagram, a sample payload — in a sibling folder of the SAME slug, `notes/<bucket>/<slug>/` (e.g. `notes/ideas/my-idea.md` + `notes/ideas/my-idea/fix.patch`). This is safe and disturbs NOTHING because every scanner lists a bucket by `isWorkItemFile` (= name ends in `.md`), so a sidecar folder is silently skipped — it is never mistaken for an item, and `(umbrella, slug)` addressing is unchanged. Rules: the sidecar is OPTIONAL and most notes have none; it is OWNED by its `<slug>.md` (the markdown references its assets by relative path, e.g. `[the patch](<slug>/fix.patch)`); it shares the note's deletion-only lifecycle (when the note is deleted, delete its sidecar too — a note leaves by deletion, and an orphaned sidecar is litter); and it is NOT a second item, so never put another item's `<slug>.md` inside it (that would hide it from scanning). It does NOT violate rule 1 (one file per ITEM) or rule 2 (no shared index) — the sidecar holds a note's OWN assets, not a manifest over many items.

   **`tasks/*` and `specs/*` MUST NOT carry a `<slug>/` sidecar.** They are FLOWING regimes: a task moves `tasks/ready → tasks/done` (and to `tasks/cancelled/`), a spec moves `specs/ready → specs/tasked` (and to `specs/dropped/`), and a co-located sidecar — which shares the item's lifecycle — would have to be `git mv`'d in lockstep on EVERY status transition. In practice it gets STRANDED: the `<slug>.md` moves to the new status folder while the sidecar is left behind in the old one, splitting ONE item across TWO status folders — a one-slug-one-folder violation (a Gate-2 BLOCK) that also buries durable, reusable engineering assets inside a transient task position no one does archaeology in. So a task's/spec's durable companion artifacts (a rebased `.patch`, a build/measurement script, a captured measurement, a diagram) live in a STABLE, NON-FLOWING home that NEVER moves on a status change — the convention is **`docs/spikes/<slug>/`** (reference material that sits alongside the ADRs it supports) — and the task/spec `<slug>.md` REFERENCES them by that stable path (any spawned finding/ADR links there too). Rationale: this removes a whole class of `ready → done` `git mv` fragility (there is nothing to move but the `.md`) and puts durable assets in a durable home instead of a transient one.

   Carve-outs (unaffected by this rule): (a) TRANSIENT BUILD SCRATCH — source trees, GBs of build objects — belongs OUTSIDE the repo entirely (the `dorfl` scratch area), never in `docs/spikes/` or a sidecar; (b) the needs-attention `work/questions/<type>-<slug>.md` file is a tooling-owned STATUS-MECHANISM file (identity-keyed, it deliberately does NOT move with the item), NOT an item asset sidecar — it is not what this rule governs; (c) `notes/*` sidecars are explicitly ALLOWED (the paragraph above) because notes do NOT flow — they leave only by deletion, so a note's sidecar never moves and cannot strand.

## Task quality rule — tests must not touch the real environment

A task that makes code **write to a SHARED / GLOBAL location** — a real home/config dir, a system path, a shared service, or an **external tool's managed store** (e.g. another agent's session directory) — MUST, as an acceptance criterion, have its **tests ISOLATE that location** (point it at a temp/scratch dir via the relevant env var or config knob) **AND assert the real one is UNTOUCHED after the run**. State the _mechanism_, not just the outcome: name the env/config lever and note WHERE the path is resolved (in-process vs in a child), because that determines whether overriding a child's env is enough or the test process's own `process.env` must be set.

This is the generalisation of the git-config isolation tests already do (`GIT_CONFIG_GLOBAL=/dev/null`): the same discipline for ANY shared write target. A task that _moves_ a write into a shared location (e.g. "write sessions to the tool's default dir instead of the worktree") silently turns previously-isolated tests into ones that pollute — and a malformed fixture in a shared store can crash unrelated tools that read it. Corollary: a synthetic fixture written into any store an external tool reads MUST be VALID per that tool's contract (capture the contract as a `notes/findings/` doc).

## Field-naming convention

All frontmatter and config field names are **camelCase** (`humanOnly`, `needsAnswers`, `blockedBy`, `taskedAfter`, `autoBuild`) — matching the JSON config and the TypeScript that parses them (1:1 property mapping, no snake↔camel translation layer). No exceptions.

## Frontmatter (YAML)

### Task frontmatter

```yaml
---
title: Human Readable Title
slug: historical-store-schema
spec: historical-store # slug of the work/specs/ready/<slug>.md this task derives from. REQUIRED iff `covers` is set; OMIT for a self-contained chore/refactor (covers: []).
humanOnly: true # gate axis 1 (DECIDED): a human must drive this. true | omitted. MOST OMIT IT.
needsAnswers: true # gate axis 2 (DISCOVERED): open questions block autonomous work. true | omitted.
blockedBy: [] # list of slugs that must reach tasks/done/ first; [] = startable now
covers: [] # optional: user-story numbers (within `spec`) this task covers
promptGuidance.testFirst: true # optional per-item NUDGE override: pin the test-first nudge ON or OFF for THIS task, regardless of the repo's resolved `promptGuidance.testFirst` policy. true | false | omitted (= inherit spec, else repo policy). NEVER an acceptance criterion — `verify` still decides pass/fail. See "`promptGuidance.*` per-item override" below.
---
```

### Spec frontmatter

```yaml
---
title: Human Readable Title
slug: historical-store
issue: 123 # optional: the issue this spec was spawned from (the surviving thread)
humanOnly: true # optional: a human must drive the TASKING of this spec. true | omitted.
needsAnswers: true # optional: open questions block AUTO-tasking this spec. true | omitted.
taskedAfter: [] # optional: spec slugs that must be TASKED first (see below). [] = taskable now.
promptGuidance.testFirst: true # optional per-item NUDGE override: pin the test-first nudge ON or OFF for every task this spec fans out, regardless of the repo's resolved policy. A per-task override still wins over this. true | false | omitted (= inherit repo policy). See "`promptGuidance.*` per-item override" below.
# tasked-ness has NO frontmatter marker: it is RESIDENCE in work/specs/tasked/ (the release transition moves the spec there).
---
```

### Finding frontmatter

A finding (`work/notes/findings/<slug>.md`) is a capture-bucket note (no status flow), but it MUST declare its **provenance** so it stays correctable (see the findings box above):

```yaml
---
title: Human Readable Title
slug: external-api-behaviour
source: 'derived from src/<the-integrating-module> @ <commit>' # REQUIRED: what the source is AND how current (a date for external sources). Be specific & honest — there is NO separate confidence field; the source string carries the weight.
---
```

- `source` is **required** — a finding without it is a `notes/observations/` signal, not a finding. State it specifically (a file+commit, a doc URL, a captured trace), so a later "the source was wrong" can revise the finding traceably.
- A **code-derived** finding describes the _external behaviour our code assumes_, never our code's internal architecture (that is `CONTEXT.md` / a `docs/` overview). If you find yourself describing our own package layout, it is not a finding.

### The two autonomy axes: `humanOnly` (decided) × `needsAnswers` (discovered)

The autonomy gate is TWO orthogonal binary fields (both default to omitted = false), present on BOTH tasks and specs, plus the repo's `autoBuild` policy:

- **`humanOnly: true` — the DECIDED axis.** _Should a human drive this, regardless of how complete the spec is?_ A product/design/security/judgement call, or an `AGENTS.md`-type rule. Driven by a decision (in the spec conversation, or the tasker's own judgement). On a SPEC it means "a human must drive the tasking". On a TASK it is the NARROW "never-for-agents BY NATURE" guard (secrets/release/security) that **survives even when the task resides in the agent pool `work/tasks/ready/`**. Task `humanOnly` is NOT the tool for ordinary "a human should review this before the agent builds it" — that job belongs to POSITION (the runner births the task STAGED in `work/tasks/backlog/`; a human promotes the approved ones into the pool `work/tasks/ready/`). See "Task `humanOnly` is NARROW" below.
- **`needsAnswers: true` — the DISCOVERED axis.** _Are there unresolved questions blocking autonomous progress?_ The spec is incomplete; **the open questions live in the body**. Once answered, the flag is cleared and an agent may proceed.
- They are **orthogonal** — four honest states. e.g. `humanOnly:true, needsAnswers:false` = fully specified but a human must own it; `humanOnly:false, needsAnswers:true` = anyone can do it once the questions are answered.
- **Repo policy `autoBuild`** answers the question the _repo_ owns: _may agents auto-build undeclared items here?_ The build member of the symmetric per-action gate family (`autoBuild`/`autoTask`/`observationTriage`). Per-repo config key (`dorfl.json`), resolved like `integration`: **CLI flag (`--auto-build` / `--no-auto-build`) > env (`DORFL_AUTO_BUILD`) > per-repo config > global config > built-in default (`false`)**.

**Predicate (same shape at both levels):** an item is **auto-eligible** iff `needsAnswers` is not `true` AND `humanOnly` is not `true` AND `autoBuild` is `true`. A human is never bound by it (a human may task/build a flagged item — the gate binds the agent, like the runner-vs-human stance on `verify`).

### `promptGuidance.*` per-item override (the same precedence shape as `humanOnly`/`autoBuild`)

The `promptGuidance` NAMESPACE is a per-repo + per-item layer of PROMPT-TEXT NUDGES the runner folds into the worker's in-band prompt (currently one member, `testFirst`; the namespace is designed to grow). It is CATEGORICALLY SEPARATE from the gate family (`verify`/`autoBuild`/`humanOnly`): a nudge changes the agent's DISPOSITION, never the acceptance bar — the `verify` gate still decides pass/fail regardless of any value here.

The repo policy resolves like every other gate-family field: **CLI flag > env (`DORFL_PROMPT_GUIDANCE_TEST_FIRST`) > per-repo config > global config > built-in default (`false`)**. On top of THAT, a single task or spec may OVERRIDE the resolved repo policy for THAT item only by setting `promptGuidance.<member>: true | false` in its frontmatter — the same repo-default-plus-item-override shape `humanOnly`/`autoBuild` use. The per-item precedence chain (highest → lowest) is:

1. **Per-task frontmatter** — the task's own `promptGuidance.<member>` line (when present).
2. **Per-spec frontmatter** — the spec's `promptGuidance.<member>` line, consulted ONLY when the task carries a `spec:` and the spec file is found in `work/specs/ready/` or `work/specs/tasked/`.
3. **Repo-resolved policy** — the value the chain above resolves to, with the built-in default `false`.

Each nudge member resolves INDEPENDENTLY — a task's `promptGuidance.testFirst` override never bleeds into a sibling member. A task with no `spec:` (a self-contained chore) MAY still carry the override; the spec layer is simply absent and the chain reads task ⇒ repo. A missing spec file is NOT an error: the override is OPTIONAL by design, so the chain silently falls through to the repo policy. Form: the frontmatter parser reads the DOTTED scalar form `promptGuidance.<member>: <bool>` (a single line, mirroring the flat shape `humanOnly`/`needsAnswers` use at the item level); a mistyped value (e.g. `"yes"`) reads as undefined — the same silent-on-malformed behaviour `humanOnly` has — never a silent coerce.

Authority: a per-item override binds the AGENT exactly like the gate-family overrides do. A human may always ignore it on a manual run (the prompt is generated; the human decides what to type).

### Task `humanOnly` is NARROW — POSITION carries "review-first"; `humanOnly` carries "never-by-nature"

Three orthogonal axes, each meaning EXACTLY one thing:

- **POSITION (folder, runner-deterministic, STRUCTURAL).** Whether a task is in the agent POOL (`work/tasks/ready/`) or in STAGING (`work/tasks/backlog/`) is computed by the runner from unforgeable inputs (the `originTrust` stamp, the per-repo placement policy, explicit operator flags). "A human should review this before an agent acts on it" is encoded HERE — the task is BIRTHED in `work/tasks/backlog/` (not eligible) and a human promotes the approved ones into `work/tasks/ready/`. The agent CREATES only in the staging folder; the runner OWNS every move + promotion.
  - **Staging is review-first admission AND the human-control position — the same folder carries BOTH.** A staging folder (`work/tasks/backlog/`, `work/specs/proposed/`) is not just "not-yet-reviewed"; it is also where an item rests so a HUMAN can drive it WITHOUT an autonomous claimer competing. Promoting an item into the POOL (`work/tasks/ready/`, `work/specs/ready/`) is EXACTLY what makes it claimable-by-anyone: the moment it lands in the pool, an autonomous claimer can grab it — a CI `advance` leg or a local `run` daemon (both are pool-only by construction). So **promote-then-drive opens a COMPETITION WINDOW** (the autonomous claimer races the human who meant to drive the work). The safe path is the inverse: a human who wants to drive an item themselves DRIVES IT IN PLACE from staging, and promotes only when (if ever) they want to hand it to the pool. The two drive-in-place mechanisms: a SPEC is **tasked in place** from `work/specs/proposed/` (TASKING-PROTOCOL.md §6), and a task is **built in place** from `work/tasks/backlog/` via `do --allow-backlog`. "I want to drive this myself" therefore means "drive it in place", never "promote, then race to claim it first".
- **NATURE (`humanOnly`, agent/human judgement, ADVISORY).** Task `humanOnly: true` means "an agent must NEVER AUTONOMOUSLY take this BY NATURE" — the rare hard case (release/secrets/security/AGENTS.md-rule) that **survives even when the task resides in the pool `work/tasks/ready/`**. The autonomy gate predicate above is exactly this: a `humanOnly: true` task is never AUTONOMOUSLY claimed (it drops out of `run`/`advance`/auto-pick selection and the conductor's READY set), even from `work/tasks/ready/`. It is NOT, however, unbuildable: an EXPLICIT human-driven `dorfl do task:<slug>` (or `claim`) STILL builds it — the readiness guard does not consult `humanOnly` on the human path (a human is never bound by `humanOnly`; it means "a human must DRIVE this"), and explicit dispatch gates on the item's own readiness, not the autonomy policy (the pool gates the policy, not the explicit claim). So the invariant is precise: `humanOnly` gates AUTONOMOUS SELECTION, never an explicit human action. Spec `humanOnly` gates auto-tasking; no folder substitute, because the tasker's input is a single spec — it must be flagged in-band.
  - As a corollary, `humanOnly` CAN be used off-label as a "keep CI/`run`/auto-pick OFF this task while I drive it by hand" latch (it excludes the task from every autonomous claimer, while explicit `do task:<slug>` still builds it). PREFER POSITION (leave it in staging `work/tasks/backlog/`) for that intent; reserve the flag for the genuine never-by-nature case. If you do use it as a latch, strip it once the task lands so it does not falsely mark the done record never-by-nature.
- **DISCOVERED (`needsAnswers`, agent judgement, ADVISORY).** Open questions block autonomous work.

Consequences for the tasker heuristic (the `to-task` skill / the tasker review loop):

- For the COMMON "a human should review this task first" case, the tasker does NOT stamp `humanOnly: true` — it lets the runner birth the task STAGED in `work/tasks/backlog/` (the position carries the review-first signal).
- The tasker flags `humanOnly: true` on a task ONLY when building THAT task is genuinely never-for-agents-by-nature (release pipeline, secrets handling, hard security boundaries, AGENTS.md prohibitions). If in doubt, leave `humanOnly` off and rely on the position — a human can always refuse to promote.

### Three honest integration modes for tasker output (`do spec:<slug>`)

The tasker-output integration combines `--propose`/`--merge` with the `tasksLandIn` placement default into three explicit, named modes:

| Mode | How to invoke | What lands where | When to use |
| --- | --- | --- | --- |
| **`--propose`** (PR path) | `do spec:<slug> --propose` (or the configured default) | A work branch pushed; a PR opened against `main`. Tasks land in the PR's tree (typically `work/tasks/backlog/`); review is the PR diff. | A repo with a host (GitHub, …) and a PR-based review culture. Code/implementation review ALWAYS uses this path — a diff cannot be folder-gated. |
| **`--merge` + land-in-staging** (PR-free review) | `do spec:<slug> --merge` with `tasksLandIn: pre-backlog` (or `--tasks-land-in pre-backlog`) | Tasks land DURABLY on `main` under `work/tasks/backlog/` (the staging folder, NOT eligible). A human promotes the approved ones `work/tasks/backlog/ → work/tasks/ready/`. | A bare / no-host / protected-`main` repo that still wants human review of ledger-file output. Review is a LEDGER POSITION a human moves, not an out-of-band PR. |
| **`--merge` + land-in-pool** (trusted no-review fast path) | `do spec:<slug> --merge` with `tasksLandIn: ready` (or `--tasks-land-in ready`) and a trusted origin | Tasks land on `main` directly in the agent POOL `work/tasks/ready/` — immediately eligible for `do` / auto-pick. | A trusted, fast-iteration repo where the tasker's output is trusted to enter the pool without ledger-position review. The runner-deterministic placement precedence still forces STAGING for an untrusted origin. |

Key rules:

- **Placement is runner-deterministic.** WHICH folder a task lands in is the runner's CALL from the `originTrust` stamp + `tasksLandIn` config + an explicit `--tasks-land-in` flag (precedence: explicit-flag > untrusted-forces-staging > configured default > built-in staging). The agent never sets it. (`tasksLandIn` names the TASK-side pool/staging slots, `ready`/`pre-backlog`.)
- **Code/implementation review is on the branch/PR path** — a code diff cannot be folder-gated. The position gate above is SCOPED to LEDGER-FILE output (tasking); the branch-based build review is unaffected.
- **`humanOnly` survives every mode.** A `humanOnly: true` task in the pool is still not agent-claimable — the position gate and the `humanOnly` gate are orthogonal.

### `taskedAfter` — spec tasking-order (enforced against `work/specs/tasked/`, NOT `tasks/done/`)

`taskedAfter: [other-spec]` on a spec is **distinct from** task `blockedBy`, and named differently because it gates a different verb against a different signal:

- **task `blockedBy`** gates **building** a task, resolved against `tasks/done/`.
- **spec `taskedAfter`** gates **tasking** a spec, resolved against `work/specs/tasked/` residence (i.e. the listed specs must already be tasked — reside in `work/specs/tasked/` — so this spec's emitted tasks can reference the real slugs of those specs' tasks in their `blockedBy`). This mirrors `blockedBy` → `tasks/done/` exactly: ordering resolves against folder residence, not a frontmatter marker.

It waits on **tasked-ness (`work/specs/tasked/`), not `tasks/done/`** on purpose: the reason B waits for A is that B's tasks need A's slugs to _exist_, which happens the moment A is tasked — not when A is fully built. Build-ordering between A's and B's actual work is then expressed where it belongs, in B's individual tasks' `blockedBy` (against `tasks/done/`). Enforced for the auto-tasker (it skips a spec whose `taskedAfter` specs do not yet reside in `work/specs/tasked/`); a human may task anyway.

### The `spec` link (required _when `covers` is set_)

`spec` names the source document this task was tasked from — the slug of a `work/specs/ready/<slug>.md` in the same repo. Its load-bearing job is to make `covers` unambiguous: `covers: [4]` means nothing without knowing _which_ spec's story 4. So the requirement tracks that job:

- **`spec` is REQUIRED iff `covers` is non-empty.** Any task that points into spec user stories MUST name the spec those numbers belong to (a task spanning multiple specs names its primary one in `spec` and references the others in prose).
- **`spec` MAY be omitted for a self-contained task** — a refactor, chore, build fix, or dependency bump that derives from no spec and covers no user stories (`covers: []`). Such a task MUST instead carry a clear, standalone _What to build_ + _Prompt_ (it is its own source of truth). This is **in contract** — not all work is feature work; only _feature_ work flows from a spec.

(Consequence, by design: a spec-less chore task is part of no spec's completion set — the "spec complete?" query counts only `spec:<slug>` tasks — which is correct, since a chore is not part of any feature's traceability.)

The body uses [task-template.md](task-template.md): What to build (end-to-end), Acceptance criteria (checkboxes), Blocked by (prose mirror of frontmatter), and a **Prompt** section — a self-contained instruction block that can be pasted into a fresh agent context, so an agent needs nothing but the file to start.
