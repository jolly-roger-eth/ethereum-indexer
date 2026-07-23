---
title: <Human Readable Title>
slug: <url-safe-slug>
# issue: 123          # optional: the issue this spec was spawned from (the surviving thread)
# humanOnly: true     # optional: a HUMAN must drive the tasking of this spec (a decision). OMIT otherwise.
# needsAnswers: true  # optional: open questions block AUTO-tasking (spec incomplete). OMIT otherwise. List the questions in the body.
# taskedAfter: []      # optional: spec slugs that must be TASKED first (so this spec's tasks can reference their slugs in blockedBy).
# promptGuidance.testFirst: true  # optional per-item NUDGE override: pin the test-first nudge ON (true) or OFF (false) for every task this spec fans out, regardless of the repo's resolved policy. A per-task override still wins over this. OMIT to inherit the repo policy. NEVER an acceptance criterion — `verify` still decides pass/fail.
---

> Launch snapshot — records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks. (The technical-detail sections below are trimmed by `to-task` once the work is tasked — they move into tasks/ADRs and this spec settles to its durable framing: Problem / Solution / User Stories / Out of Scope.)

<!-- open-questions -->
<!--
  TRANSIENT BLOCK — stripped by the apply rung on full resolution.
  While the spec has unresolved questions blocking autonomous tasking:
    1. Set `needsAnswers: true` in the frontmatter above.
    2. List the questions under the `## Open questions` heading below.
    3. Clear the flag (and let apply strip this block) once they are answered.
  Delete the whole fenced block — markers and all — if the spec launches fully resolved.
-->

## Open questions

1. <question one>
2. <question two>

<!-- /open-questions -->

## Problem Statement

The problem the user faces, from the user's perspective.

## Solution

The solution, from the user's perspective.

## User Stories

A LONG, numbered list — the heart of the spec. Format:

1. As a <actor>, I want <feature>, so that <benefit>.

Cover all aspects of the feature, extensively.

### Autonomy notes (the two gate axes — set the frontmatter flags accordingly)

The spec now CARRIES the tasking gate (because an agent may auto-task it with no human in the loop). Record, in prose here AND as the frontmatter flags above:

- **`humanOnly` (DECIDED):** set `humanOnly: true` on the spec ONLY to mean "a human must drive the _tasking_ of this spec" (sole effect: an agent may not auto-task it). This is DISJOINT from task `humanOnly` — it does NOT propagate to or guide the tasks' gates (a `humanOnly` spec can yield fully agent-buildable tasks). The tasker sets each task's gate from that task's own build-nature.
- **`needsAnswers` (DISCOVERED):** are there open questions the spec has not yet resolved? If so, fill in the `## Open questions` block at the top of the spec (it carries the authoring instructions and the marker fence the apply rung uses to strip it on resolution) — the auto-tasker will refuse to task until they are answered and the flag cleared. Be HONEST: a flagged-incomplete spec is correct; a falsely-complete one produces wrongly-cut tasks. (Omit both flags if everything is resolved and straightforwardly agent-taskable.)

## Implementation Decisions

Decisions made at launch (modules to build/modify, interfaces, architectural choices, schema, API contracts, specific interactions). No file paths or code snippets (they go stale) — except a decision-encoding snippet from a prototype (state machine, reducer, schema, type shape), trimmed to the decision-rich part.

> Trimmed at tasking-time: this detail moves into the tasks (what to build) and, where it's a durable rationale, into an ADR (`docs/adr/`). It is here only to seed the tasking.

## Testing Decisions

What makes a good test (external behaviour, not implementation details); which modules/seams will be tested; prior art in the codebase.

> Also trimmed at tasking-time (moves into tasks' acceptance criteria / an ADR).

## Out of Scope

What is deliberately not being done (and, where useful, where it lives instead — e.g. an incubating idea in `work/notes/ideas/`).

## Further Notes

Anything else worth recording at launch.
