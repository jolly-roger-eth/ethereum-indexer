# SURFACE-PROTOCOL

The **surface-questions discipline** the autonomous runner invokes by name on ONE `work/` item before that item can advance a lifecycle rung. The runner spawns a fresh-context agent and tells it to "run the surface protocol"; that agent reads THIS doc and applies its standard.

The protocol describes how work is AUTHORED (`WORK-CONTRACT.md`, the templates), CLAIMED and BUILT (`CLAIM-PROTOCOL.md`, the `verify` floor), JUDGED BEFORE LANDING (`REVIEW-PROTOCOL.md`) and — when judgement is genuinely open — has its OPEN QUESTIONS SURFACED for a human to answer (this doc). It is in-band in every set-up repo, never host-specific. (The human-facing pointer is `skills/surface-questions/SKILL.md`; the standard lives here.)

> This doc is **protocol-native**: it assumes the repo uses the `work/` contract and surfaces the open-judgement residue of an item AGAINST that contract. Every bare "WORK-CONTRACT" / "REVIEW-PROTOCOL" mention below refers to `work/protocol/<doc>` in the repo under work.

It is **doc-shaped, exactly like `review`**: you produce an assessment (here, a set of questions) and the **caller routes/persists it**. You never set `needsAnswers`, never write a sidecar, never `git mv`, never commit. The advance engine's surface-question rung spawns you fresh-context, takes your questions, and **ITSELF writes the sidecar (CAS-atomic)** — exactly as the review gate uses `review`. **The skill judges; the engine persists.**

## The two laws (state them; they keep the tool honest)

1. **GATHER-only.** Your job is to FORMULATE the open questions for the item — by composing the existing reviewing/triage judgement, not by re-deriving it. You add no new disposition of the item.
2. **PERSIST-NEVER.** You EMIT questions and **write nothing** (no `needsAnswers` edit, no sidecar, no `git mv`, no commit) — mirroring `review`. The caller (the advance engine, or a human) routes and persists. If you are tempted to write a file, STOP: that is the engine's job (or, by hand, the `advance` verb — see [the no-runner path](#the-no-runner-path)).

**The humility rule (the heart of it):** you **surface the residue, you NEVER invent an answer.** A `default:` is a _suggested_ default offered for the human's convenience — it is a humility aid, not a decision, and it never substitutes for the human answering. Automating answer creation is rejected by design; the human is the clock. When judgement is genuinely open, that is a QUESTION — never a guess dressed as a resolution.

## When to use vs. not

- **Use** to formulate the open questions for ONE item before it can advance a lifecycle rung — a task or spec that may carry open judgement, an untriaged observation, code in a work PR — whether you are the advance engine's surface rung or a human doing it by hand with no runner.
- **Don't** use it to PRODUCE an item (that is `to-spec` / `to-task` / the build agent), to APPLY a human's answer or advance the item (that is the engine's apply rung / the `advance` verb), or to PERSIST the questions (the engine, or the `advance` verb, owns the write). And do not use it to invent answers — there is no answer-creation here, by design.

## What you COMPOSE (single sources — do NOT duplicate)

You are a GATHERER. You stand up the existing producers/reviewers and collect what they emit; you do not reimplement their judgement. `to-task` and `review` stay the single sources, **composed and UNCHANGED**.

1. **`review` (`work/protocol/REVIEW-PROTOCOL.md`) — for a task / spec / code.** Run the `review` discipline; it EMITS a verdict `{verdict, findings:[{severity, question, context}]}` and writes nothing. ROUTE its **`block`** findings into your emitted questions (a blocking finding is an open question that must be answered before the item advances). A non-blocking finding is a nit — record it as an optional/low-priority question, never as a blocker. Do NOT re-derive review's lenses here; you call review and carry its findings over.
2. **The native observation-triage question — for an observation.** An observation has no gate for `review` to assess; its native question is **"what should become of this signal?"** (resolve / promote / delete / duplicate). **This one question is DETERMINISTIC and engine-owned:** the advance engine ALWAYS surfaces it (as `q1`) for every untriaged observation, built from a fixed template, NOT from your emit. It can never be zeroed out or lost to a flake, so a record / a rationale note / a fresh-bug signal are all surfaced identically and the human always decides the disposition. **Your role for an observation is ADDITIVE:** investigate the observation's claim against current reality (code / tasks / specs / ADRs) and emit any EXTRA pointed questions the body genuinely raises (e.g. a specific open sub-question the note itself asks) — the engine appends them AFTER the deterministic triage question. If the observation raises no extra question of its own, emit an empty `questions` array: the deterministic triage question still lands, so the observation is never stuck. (You do NOT need to emit the "what becomes of this signal?" question yourself — the engine owns it; emitting it too would merely duplicate `q1`.)
3. **The item's PRE-EXISTING open questions.** Collect what the item already carries: a `needsAnswers: true` item's `## Open questions` block, and any open question already written in the body. Carry each over verbatim as an emitted question (with its context). These are open judgement the author already named — they must surface, not be silently dropped.

For each gathered question, attach **inline CONTEXT** (the relevant excerpt / `file:line` / the reasoning — so the human need not open the source item) and, where you can honestly suggest one, an **optional suggested DEFAULT** (the humility aid — never a decision).

## The emitted question shape (MUST match the sidecar)

The questions you emit MUST match the **sidecar entry fields**, so the engine persists them with **zero translation**. The runtime PARSER (`parseSurfaceEmit`) is the source of truth for the shape; this prose mirrors what it enforces.

Emit a single JSON object of this exact shape (no prose OUTSIDE it):

```json
{
	"item": "<type>:<slug>",
	"questions": [
		{
			"question": "…",
			"context": "…",
			"default": "… (optional; omit if none)"
		}
	],
	"note": "… (optional free prose; your reasoning / findings live HERE)"
}
```

- **`item`** — OPTIONAL, the namespaced identity the surface is for (orientation only; the resolver owns identity — the parser tolerates absence).
- **`questions`** — REQUIRED, an ORDERED array. An EMPTY array is VALID — the honest "no open judgement" result; absence is NOT (the parser rejects it, never a silent surface). Each entry is:
  - **`question`** — REQUIRED, the question verbatim. An all-whitespace question is dropped as a placeholder.
  - **`context`** — OPTIONAL, inline context so the human need not open the item (the relevant excerpt / `file:line` / reasoning).
  - **`default`** — OPTIONAL, the suggested default — the humility aid; omit when you cannot honestly suggest one (never fabricate a default just to fill the field).
- **`note`** — OPTIONAL free-prose channel for your reasoning / findings (the surface counterpart of the verdict's `review` field). It is the HOME for any explanation you want to give: put it HERE, INSIDE the object, never as prose around the JSON. The engine does not persist `note` (the parser ignores it); its only purpose is to give your prose somewhere to go so the emitted object can be your final, clean, single-object output. Like `review`, keep it short and single-line (write `\n` literally, never a raw newline).

There is NO `disposition` field, and no token vocabulary to learn or pick: a sidecar entry is BINARY (no-answer | answered), and the human answers in PLAIN LANGUAGE. What to DO with the answer — mint a task, a SPEC, or an ADR; delete the source; or ask a follow-up — is the agentic apply decision (read off the human's answer + the source item), not a token the surface emits. An observation's triage question is therefore just an ordinary plain question ("what becomes of this signal?"); the human writes back in their own words, and if the answer is "throw it away", the discharge is the direct-delete path (the human, the `answer-questions` skill, or the `dorfl` delete verb removes the source + sidecar in one revertible commit), not a `delete` token.

You do NOT assign ids, `answered:`, `answer:`, or `allAnswered`. Those are the SIDECAR's machine-owned fields — the engine assigns the stable monotonic id (`q1`, `q2`, …), the human fills `answer:`, and the serialiser derives `answered:`/`allAnswered`. You emit only the three authoring fields above; the engine owns the rest. (This is precisely why you must not write the sidecar: you do not own its machine fields.)

Because the shape is the sidecar's, the engine APPENDS your questions to any existing sidecar (never overwriting an already-answered entry) and writes the whole thing in one CAS-atomic commit. You need not know any of that — you just emit the four fields.

If the item carries **no open judgement** (review approves with no blocking findings, an observation raises no extra pointed question of its own beyond the engine's deterministic triage question, nothing pre-existing) — emit the object with an **empty `questions` array** (put WHY in `note`). Surfacing no EXTRA question is a valid, honest result; do not manufacture a question to look busy. Do NOT replace the empty-array object with a prose explanation: the JSON object is always your output, even when it carries no questions.

> **Empty is VALID, absence is NOT.** This is a hard rule the runtime parser (`parseSurfaceEmit`) enforces: `"questions": []` is a valid, honest "no open judgement" result; ABSENCE of the `questions` field is rejected as an unparseable emit and strands the surface rung (the failure mode observed in `surface-rung-agent-emits-no-parseable-questions` and its 2026-07-10 recurrence on decision-record observations). When you have nothing to ask, the safe close is ALWAYS `{"questions": [], "note": "…"}` — not a prose sentence, not a skipped emit, not a dropped `questions` key.

> **For an OBSERVATION, an empty emit is never a dead end.** The advance engine ALWAYS surfaces the deterministic triage question (`q1`, engine-owned — see "What you COMPOSE" item 2), so an empty `questions` array from you simply means "no EXTRA question beyond the triage one," and the human still gets asked what should become of the observation. Your empty emit (or even a flake) is therefore non-fatal for an observation: the triage question lands regardless. (For a TASK / SPEC there is no engine-owned base question, so an empty emit there is the genuine "nothing surfaced" no-op.)

**The emitted object is your FINAL and ONLY output.** Do not narrate your process, and add no remark, summary, or sign-off before or after it — and take no further turn once you have emitted it (emitting it is how you finish). The caller reads only your LAST turn, so a trailing chatty turn AFTER the object discards the emit and strands the run. This is the same discipline Gate-2's verdict carries; the `note` field exists precisely so all your prose has a home inside the object.

### How the caller persists your questions (NOT your job — for orientation only)

- **The advance engine's surface-question rung** spawns you fresh-context, takes your emitted questions, and writes them to the sidecar `work/questions/<type>-<slug>.md` CAS-atomically (assigning ids, appending, setting `needsAnswers: true`). The skill judges; the engine persists.
- **A human (no runner)** persists via the `advance` verb (see below), or hand-writes the documented sidecar format.

## The no-runner path

You stay **human-invokable**. A human with no runner can invoke this discipline by hand, take the emitted questions, and persist them one of two ways:

- **Persist via the `advance` verb** — the apply/surface rung of the `advance` command (a **sibling top-level verb**, like `do` and `run`). It is `advance`, **NOT `do advance`** — `advance` is its own verb.
- **Hand-write the documented sidecar format** — write `work/questions/<type>-<slug>.md` by hand per the human-readable Markdown shape below. Because the emitted shape already matches the sidecar entry, this is a transcription, not a translation.

The hand-written sidecar shape (the SAME file is both human-readable on GitHub and machine-parseable — the machine fields hide in HTML comments that GitHub renders as nothing, the human content is real Markdown):

```
<!-- dorfl-sidecar: item=<type>:<slug> type=<type> slug=<slug> allAnswered=false -->

## Q1

**<the question, verbatim>**

> <inline context so the human need not open the item>

_Suggested default: <optional default; omit the whole line if none>_

<!-- q1 fields: id=q1 -->

**Your answer** (write below this line):

## Q2

**<next question…>**

…
```

Notes for the hand-writer:

- The **identity HTML comment** at the top carries `item`/`type`/`slug` and the derived `allAnswered` mirror. Set `allAnswered=false` on first write (no answers yet); the engine recomputes it on every subsequent serialise.
- Each entry opens with a `## Qn` heading (`Q1`, `Q2`, …, monotonic — never reused). The heading is BOTH the entry separator and the answer-region boundary.
- The **question is a bold line**, the **context is a Markdown blockquote** (each line prefixed `> `), the **default is one italic line** prefixed `_Suggested default: ` and closed with `_`. Omit context/default lines entirely when absent.
- The **per-entry HTML comment** carries `id=qN`. There is no `disposition=` field (the token vocabulary is retired — an entry is binary). Do NOT add an `answered=` field either — the engine derives answered-ness from the answer text and only emits the override when it disagrees with that derivation.
- The fixed marker `**Your answer** (write below this line):` is followed by an empty region; the answer is everything from the marker up to the next `## ` heading (heading-delimited so a `---` inside an answer cannot break parsing).
- The human just types prose under the answer marker — no `key:`, no escaping, no fence.

### The optional `kind=` dispatch axis (interim primitive)

An entry MAY carry an optional `kind=<value>` machine-only dispatch axis in its per-entry HTML comment (`<value>` ∈ `merge` | `stuck` | `triage` | `spec`), read by the `advance` apply rung to route runner-ACTION questions (`merge`, `stuck`) to deterministic dispatch vs CONTENT questions (`triage`, `spec`) to the agentic `decide()` path. Absent ⇒ the plain binary content entry (every pre-`kind` sidecar parses + renders byte-identically). This is an INTERIM primitive — removable once question sidecars move to kind-based SUBFOLDERS (`work/questions/merge/`, …), where the folder ENCODES the kind and this per-entry field is redundant.

Three ratified rules govern the on-disk shape of this axis (recorded here so `packages/dorfl/src/sidecar.ts` is not the sole home):

- **Token spelling is `kind=<value>`.** No alternative spelling, no synonyms — the literal token is `kind=`, mirroring the `id=` / `answered=` house style.
- **Order within the comment: `kind=` is emitted AFTER any `answered=` token** (i.e. `<!-- qN fields: id=qN [answered=…] [kind=…] -->`). Emit order is load-bearing because the comment IS the on-disk surface — downstream diff tools see it, so the order is fixed rather than left implementation-defined.
- **Unknown `kind=` values are SILENTLY DROPPED on re-serialise** (silent-on-malformed, matching the retired `disposition=` precedent — never a throw, never a coerce). A mistyped or unknown token parses to `undefined` and is NOT echoed back on serialise. CONSEQUENCE: round-trip is NOT byte-preserving for unknown tokens. This is BY DESIGN — it keeps parse/serialise symmetric on the KNOWN grammar and stops downstream code from silently depending on opaque passthrough. Do NOT "fix" it by adding echo-through; that would reverse the decision.

**No separate write-skill is added.** Hand-writing the sidecar (or the `advance` verb) is enough. Do not invent one here.

## Boundaries (the scope fence)

- **`to-task` / `review` stay COMPOSED and UNCHANGED.** You call them; you never modify or reimplement them. They are the single sources for tasking/reviewing judgement.
- **You formulate the questions for ONE item; you do not batch, apply, or iterate.** Batching, applying answers, and iterating are the ENGINE's job (or `orchestrate`'s, for the human batch) — NOT yours.
- **You write nothing and you invent no answer.** Both laws, restated because they are the whole point: GATHER-only, PERSIST-NEVER; surface the residue, NEVER invent an answer.
