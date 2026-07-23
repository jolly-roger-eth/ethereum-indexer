# REVIEW-PROTOCOL

The **review discipline** the autonomous runner invokes by name on a `work/`-protocol artifact before that artifact is _trusted_ — a task before it lands/is claimed, code in a work PR against the task that specified it, a spec before tasking, a set of tasks before they land, or a captured note. The runner spawns a fresh-context agent and tells it to "run the review protocol"; that agent reads THIS doc and applies its standard.

The protocol describes how work is AUTHORED (`WORK-CONTRACT.md`, the templates), CLAIMED and BUILT (`CLAIM-PROTOCOL.md`, the Gate-1 `verify` floor), and JUDGED BEFORE LANDING (this doc). It is in-band in every set-up repo, never host-specific. (The human-facing pointer is `skills/review/SKILL.md`; the standard lives here.)

> This doc is **protocol-native**: it assumes the repo uses the `work/` contract and reviews the artifact AGAINST that contract. Every bare "WORK-CONTRACT" / "ADR-FORMAT" mention below refers to `work/protocol/<doc>` in the repo under review.

You **emit a verdict; you do not act on it** — see [Your output](#your-output). Routing the verdict (to `needsAnswers`, needs-attention, a batch file, a merge) is the caller's job. This discipline is the _assessment_, not the disposition.

## When to use vs. not

- **Use** to review: a **task** (well-cut? claim-ready?); **code** in a work PR (does it deliver the task it claims?); a **spec** (taskable? gate axes honest?); a **note** (right bucket? actionable?); or a **set of tasks** — the whole-SET lens: **graph coherence / gaps / overlap / goal-composition** (does the dependency graph cohere, are there set-level gaps or overlapping/duplicated tasks, and do they compose into the spec/ADR goal?). The set-level checks live in lens 3 (cross-artifact composition) and lens 5 (the destination check).
- **Don't** use it to _produce_ the artifact (that's `to-spec` / `to-task` / the build agent), nor to _route_ the verdict (that's the caller — a review gate, a conductor skill, or a human). This protocol only assesses.

## The core disciplines (what makes a review thorough, not shallow)

These are _why_ this beats a single "looks fine" pass — apply them throughout:

1. **Run a SEQUENCE of distinct angles, not one pass.** Each lens below is a different framing. Re-running the _same_ angle converges on nothing fast; changing the angle keeps finding distinct _classes_ of defect. Stop when a full pass across the angles finds nothing NEW.
2. **A reviewer is ADVERSARIAL.** Try to _break_ the artifact ("attack these tasks: granularity? dependency order? gate correctness? drift? a missed seam?"), don't confirm it. Self-review in the producing context rubber- stamps; review as if someone else wrote it (ideally a fresh/cold read).
3. **Verify against what ACTUALLY LANDED, not intent or memory.** Read the real code / the committed artifact — not what you _think_ a change did. Edits silently fail; specs drift. Trust the bytes on disk.
4. **A SECOND instance of the same finding is a SIGNAL, not noise.** "I've seen this shape before" → generalise the fix, don't patch instances one by one (this applies to the artifact's defects _and_ to your own repeated mistakes).
5. **Defects concentrate in the TASK/SPEC more than in the code.** Agents build what they're told, correctly; the expensive bugs are an ambiguous premise, a wrong "reuse X", an assumed-but-absent seam, a stale central assumption. Spend the most scrutiny on the spec.
6. **Flag, don't guess.** When something is genuinely unresolved, that is a `block`/`needsAnswers` finding — not a guess dressed as approval. A false "looks fine" ships wrong-but-compiling work; a flagged question costs one human glance.
7. **Weight findings by REAL impact — do not cargo-cult the lenses.** A finding is only worth raising if acting on it changes an outcome someone would actually hit. A technically-true nit that no reader/builder/runtime will ever be bitten by is NOT a `block` (often not even worth recording). Running a lens as a checklist and reporting conformance misses ("this optional field is empty", "a list could be renumbered") as blocking is the failure mode this rule exists to stop: it buries the findings that matter under bookkeeping noise. Ask of each finding: _who hits this, and what breaks?_ No answer → drop it. The lenses find candidates; impact decides severity.

## The lenses — apply IN ORDER, ending in the destination check

For each lens: _what it catches_ + _how to apply it (against the contract)_.

### 1. Claim-vs-reality

Every concrete claim the artifact makes, checked against the real world.

- Task/spec: each referenced symbol, path, function signature, "reuse X" — does it exist and have the assumed shape? (Catches ghost paths, wrong module homes, "reuse X" where X is private / wrongly-shaped.)
- Code: does the diff actually do what its task/commit claims?
- Any doc: does it match what landed in `tasks/done/` and the relevant ADRs/findings?
- **Drift is a `needs-attention` / `needsAnswers` signal**, never something to paper over (WORK-CONTRACT.md). A task built on a stale premise is a `block`.

### 2. Cleanup-vs-behaviour

Anything framed as removal / dead-code / no-op, checked for **hidden live behaviour** (e.g. a flag claimed "just cleanup" that is actually still read somewhere). If a "cleanup" changes behaviour, that's a defect or an unowned scope.

This lens also owns **acceptance-criteria conformance** for code:

- Does the code meet every acceptance criterion of its task?
- **Shared-write isolation rule (WORK-CONTRACT.md):** if the code writes to a shared/global location (a real home/config dir, a system path, a shared service, an external tool's store), do its tests ISOLATE that location (temp/scratch via the named env/config lever) AND assert the real one is UNTOUCHED? A missing isolation test is a `block` — it silently pollutes and can crash unrelated tools.

### 3. Cross-artifact composition (contract conformance)

Do the artifacts COMPOSE, and do they obey the contract?

- **Composition:** handoffs (one task ships a stub another fills), shared helpers with no owner, two tasks editing the SAME file/command in parallel (a merge conflict waiting to happen — should carry a `blockedBy` to serialise), one task deleting another's live tooling, cross-task side-effects.
- **Wide-refactor sub-checklist** (a pervasive rename / identifier cutover split into a `rename-*` chain — complements `TASKING-PROTOCOL.md` §3a):
  - **Expand-first / per-batch compilability.** For EACH batch, verify it is either **indirected-safe** (the renamed identifier is read through a key/indirection so a hard swap keeps `pnpm -r build` green in isolation) OR **expand-first** (a prior batch added the new form beside the old across the whole non-indirected surface, this batch is an additive migrate, a later contract batch removes the aliases). A linear sequence of hard-swap `rename-*` batches over NON-indirected identifiers cannot compile per-batch and must be restructured into expand → migrate → contract. (Motivation: the spec→spec identity chain shipped review-clean, yet batch 2 stopped at build time — `fm.spec` / `'spec'` were non-indirected, read at ~28 call sites, and could not compile alone.)
  - **File ownership per clause.** For EACH acceptance clause of EACH batch, identify which file(s) it must change and verify THIS batch owns them; a clause whose file lives in another batch is a scope-fence violation and must be moved to the batch that owns the file. (Motivation: batch 2 carried a `do spec:` / `advance spec:` verb-dispatch clause, but the dispatcher lives in `do.ts` / `advance.ts` / `advance-drivers.ts` / `do-autopick.ts` — batch 4's files — so the clause was unsatisfiable inside batch 2's scope fence and the `do` agent correctly STOPPED.)
- **Contract conformance (assume these rules; flag violations):**
  - **status = folder**, never a frontmatter field; **one file per item**; **no shared index/manifest**.
  - **content-derived slug**, never a counter; **camelCase** field names (`humanOnly`, `needsAnswers`, `blockedBy`, `taskedAfter`).
  - **gate axes set HONESTLY** — `humanOnly` (a human must drive this) and `needsAnswers` (open questions, listed in the body) reflect the artifact's real nature; a task's gate is decided from _building that task_, NOT inherited from its spec; a falsely-complete `needsAnswers:false` is a defect.
  - **`blockedBy` / `spec` / `covers`** present and correct (`spec` required iff `covers` is set); deps reference real slugs.
  - **bucket polarity** for notes: _observation_ = spotted/unverified (append-only); _finding_ = verified EXTERNAL/domain ground truth; _ADR_ = a decision WE made + why (in `docs/adr/`). A note in the wrong bucket is a finding.
  - **a task's `## Prompt`** is self-contained (an agent could start from the file alone) and includes the drift-check.

### 4. Conceptual coherence (does it fit the system's LANGUAGE?)

The artifact may be internally correct yet INCOHERENT against the concepts the system already has. This lens catches the conflation that mechanical conformance (lens 3) and claim-checking (lens 1) miss — a single concept applied at the WRONG LAYER (e.g. a policy gate placed on an explicit verb when it should gate only the autonomous selection step), an inconsistency that can otherwise survive across multiple tasks and specs.

For each concept / flag / config key / verb / status the artifact introduces or touches, ask three questions:

- **(a) Consistent meaning?** Is the term used the SAME way it is already defined elsewhere (the project's `CONTEXT.md` glossary is the source of truth, plus the ADRs, other tasks, the code)? A term that silently RE-MEANS an existing word — or means two different things in two places — is incoherent.
- **(b) Right layer?** Is the concept placed at the conceptual layer it actually belongs to? (A policy gate on the autonomous-SELECTION step vs on the explicit VERB; a knob on the loop vs on the one-shot; a check on "who invoked" when the system cannot even distinguish the invokers.) A correct mechanism at the wrong layer is incoherent.
- **(c) Duplicate / overlap?** Does it FORK an existing concept under a new name instead of reusing or renaming the one that already exists? (Two flags meaning "isolate"; a new status that is really an existing one; a second lock primitive.) If it overlaps, the artifact should reuse/rename, not add.

A concept that is coherent in ISOLATION but incoherent against the system's existing language is a `block` (or, for a task/spec not yet built, a `needsAnswers` / re-scope). Coherence is a first-class quality, not a nicety: an incoherent concept is debt that compounds silently across every artifact that later reuses the muddled term. When you spot the muddle, also check whether the GLOSSARY (`CONTEXT.md`) needs the term pinned so the next author cannot re-fork it.

### 5. The destination check (the final, highest-value move)

_"If every task is built / the code is merged exactly as written, do we END UP WITH the system the spec/ADR describes?"_ — distinct from per-piece correctness, and the strongest signal a decomposition is trustworthy (especially with no human).

- Take the spec/ADR end-state as the target; **map every promised element to a delivering task** — a hole = an element no task delivers.
- Confirm **coverage is complete + non-duplicated** — every user story covered exactly once.
- Audit the **deletion sweep** — a new system means the OLD surface is GONE; every removal owned by exactly one task, none unowned or double-owned.
- Check for **orphans** (a task delivering something the end-state doesn't need) and that assumed-pre-existing foundations actually exist.
- Confirm **deliberate non-deliveries are flagged** as named follow-ups, not silently missing.

**`approve` must mean "provably reaches the spec/ADR goal," not "each piece looks fine."** If this lens finds a hole, it is the most important thing to `block`.

## Your output

Emit a verdict per reviewed item — and **write nothing** (no frontmatter edits, no `git mv`, no file changes). The caller routes it.

The verdict is a single JSON object with this shape (the **emitted-shape contract**). The runtime PARSER is the source of truth for the shape; this prose mirrors what it enforces:

- `verdict` — REQUIRED, exactly `"approve"` or `"block"`. `approve` lets the artifact proceed; `block` keeps it out (the caller routes to needs-attention / `needsAnswers` / a comment).
- `findings` — REQUIRED, an array (possibly empty). Each finding is:
  - `severity` — `"blocking"` (keeps the item out of "ready") or `"non-blocking"` (a nit / future improvement). Be honest about which.
  - `question` — the question / defect, with enough context to act WITHOUT re-deriving it.
  - `context` — OPTIONAL, the relevant excerpt, `file:line`, or reasoning.

Several caller-specific optional channels MAY ride on the same JSON object. They are OPT-IN: each caller's prompt names which ones to fill. The shape they take when present:

- `review` — a single deliberately-authored, human-readable REVIEW string the caller posts as a comment on the PR (leads with Approved/Blocked, then the lenses + the destination-check reasoning). Plain text inside the JSON string. Advisory only — never gates the verdict.
- `edits` — full-content edits to apply between passes in an improver loop: an array of `{path, content}`, where `path` is a repo-relative target (typically `work/tasks/backlog/<slug>.md`) and `content` is the FULL replacement file body. The runner writes them; the agent does no disk/git.
- `edit` — for the lone-task review only: a single in-memory full-replacement task BODY (the markdown AFTER the frontmatter), applied before the next round. No path — the task has not been emitted yet.
- `questions` — an array of strings carrying open questions for a human to answer (the non-converge sink in the lone-task review).
- `uncertainTasks` — for the tasker improver loop: specific tasks to emit `needsAnswers: true` with the questions in their bodies. Each is `{path, questions: string[]}`.
- `decompositionUnclear` — for the tasker improver loop: when the WHOLE decomposition is unsound, `{questions: string[]}` to record as the spec's needs-attention reason.

Any unrecognised field is ignored by the parser; the caller routes on `verdict`/`findings` plus the channels its prompt asked for.

**Keep the JSON parseable** (a malformed verdict strands the work). Emit defensively: emit it MINIFIED on ONE single line; do NOT use a literal double-quote `"` inside any string value (paraphrase, or use single quotes — a dropped escape on an inner `"` is the most common corruption); keep every string field SHORT and SINGLE-LINE (write `\n` literally, never embed a real newline / tab / control char); and cap the longest field (`review`) at roughly 1500 characters — say less, not more.

### How callers route your verdict (not your job — for orientation only)

- a **review GATE** routes a `block` → set `needsAnswers: true` on the artifact (question in its body) or surface a `work/questions/<type>-<slug>.md` sidecar + `needsAnswers: true` (needs-attention; post `retire-stuck-lock-state` the lock is never left `stuck` — that state is retired); `approve` → let it land / auto-merge.
- a **conductor** (e.g. `drive-tasks`/`orchestrate`) routes a `block` → into its stuck-set / batched questions for the human; `approve` → merge / advance.

## Scope fence

This doc is the review _protocol/discipline_ only. The review **gates** — _when_ review runs (task-time / PR-time), per-repo toggles, the model override, the `--propose` PR arbiter, auto-merge-on-approve, the role/seam wiring, the trust resolver — are NOT here; they live in the runner machinery. This protocol assumes nothing about its caller beyond "you will route my verdict."
