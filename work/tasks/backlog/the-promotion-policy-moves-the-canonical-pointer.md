---
title: 'The promotion policy moves the canonical pointer, on-catch-up by default everywhere'
slug: the-promotion-policy-moves-the-canonical-pointer
spec: a-reconfigure-is-not-an-outage
blockedBy: [a-generation-pauses-by-cap-and-drain]
covers: [1, 3, 13, 14]
---

## What to build

The POLICY that decides when the canonical pointer moves. The registry owns the pointer as a
mechanism; this owns WHEN it moves, and the TRIGGER, and what happens to the generation left behind.

This was decided in prose and owned by NOTHING, which left stories 1, 3, 13 and 14 with no delivering
task — including the production default and the one story 1 asks for.

### Three values, and `on-catch-up` is the DEFAULT EVERYWHERE

There is **no per-runtime and no per-environment default**, because the axis that would select one is
NOT DETECTABLE: promotion would want a DEVELOPMENT-versus-PRODUCTION distinction, and nothing in a
browser build can tell which it is in. An undetectable axis with a dangerous default is worse than no
axis, so the safe value is the default and the unsafe one is a deliberate opt-in.

- **`on-catch-up`** (DEFAULT, everywhere) — the pointer moves when the new generation reaches the old
  one's cursor. This is what story 1 asks for (the app keeps rendering and switches when ready) and
  what story 14 wants (an app author's users should not see state go backwards).
- **`immediate`** — the new generation becomes canonical the moment it is created, before it has caught
  up. OPT-IN. It is what story 13's developer iterating on a handler wants, because stale-but-complete
  answers from the old processor are more confusing than incomplete answers from the new one. It is not
  something a deployment should ever land in by accident.
- **`manual`** — the pointer moves only when asked, so an operator can inspect first.

**The TRIGGER** is the successor reaching the cursor the CANONICAL generation had.

### `checkTxInclusion` degrades HONESTLY under `immediate`

This was CHECKED against `verdictFor` rather than assumed, including which BASIS answers — the two
differ and only one of them was checked the first time:

- a caller with NO `minedAtBlock`, on a generation still catching up (`lastToBlock < latestBlock -
  finality`), gets `unknown` / `window-not-covering`;
- a caller WITH a `minedAtBlock` ABOVE the cursor gets `absent` / **`ahead-of-cursor`**, because that
  branch is tested BEFORE the window-not-covering one. **The STATUS is `absent`**, so any claim that a
  catching-up generation never answers `absent` is wrong on the code.
- a generation with no `lastSync` answers `unknown` / `not-synced`.

The SAFETY conclusion survives on the BASIS rather than on the status: `ahead-of-cursor` means "not
processed that far yet", which is the correct direction for the caller this exists for — an optimistic
update laid over a generation that has not reached the transaction is right, not double-counted.
**What must not be built is a consumer switching on `status` alone.**

### Drop-on-promotion is INCOMPATIBLE with `immediate`, resolved by ORDER not by an interlock

`immediate` promotes a generation that has caught up to NOTHING, so dropping the previous one at that
moment discards a complete state for an empty one, with no fallback when the new processor throws on
its first event.

So: **drop-on-promotion applies only under `on-catch-up` and `manual`**, where promotion means the
successor demonstrated something. **Under `immediate` the previous generation is RETAINED until the new
one reaches the cursor the old one had at promotion, and only then dropped.** Because `immediate` is
opt-in rather than a default, this is a documented consequence of a deliberate choice rather than a trap
the primary runtime falls into.

## Acceptance criteria

- [ ] Three promotion policies exist — `on-catch-up`, `immediate`, `manual` — and **`on-catch-up` is
      the default in EVERY runtime**. Assert there is no per-runtime or per-environment default
      selection anywhere.
- [ ] The TRIGGER is the successor reaching the cursor the canonical generation had; assert the pointer
      moves at that moment and not before.
- [ ] **Reads succeed continuously across a reconfigure** and answer from the canonical generation
      until the pointer moves (stories 1 and 3). Assert on the ANSWERS, since reads do not report
      identity.
- [ ] Under `immediate`, the new generation is canonical from creation (story 13), and under
      `on-catch-up` the old one keeps answering until the successor is ready (story 14).
- [ ] **`checkTxInclusion` degrades honestly under `immediate`**, asserted on the BASIS and not only
      the status: no `minedAtBlock` while catching up gives `unknown`/`window-not-covering`; a
      `minedAtBlock` above the cursor gives `absent`/**`ahead-of-cursor`**; no `lastSync` gives
      `unknown`/`not-synced`. A test written from "a catching-up generation never answers `absent`"
      would be wrong, which is the point of asserting it.
- [ ] **Drop-on-promotion applies only under `on-catch-up` and `manual`.** Under `immediate` the
      previous generation is RETAINED until the successor reaches the cursor the old one had at
      promotion, and only then dropped. Assert the retention directly — a build that drops on
      `immediate` passes every other criterion here.
- [ ] A generation whose successor is promoted is dropped only per the rule above, never evicted by a
      cap.
- [ ] Ship a changeset for every published package whose surface changes.
- [ ] `pnpm build && pnpm typecheck && pnpm test` green.

## Blocked by

- `a-generation-pauses-by-cap-and-drain` — serialises the browser module these share.
- Transitively requires the registry (the pointer), the container (which holds the generations) and a
  RUNNING non-canonical generation (the trigger presupposes a successor that is moving); all are
  ancestors of the blocker above.

## Prompt

> Build the PROMOTION POLICY for the `etherfold` monorepo: when the canonical pointer moves, what
> triggers it, and what happens to the generation left behind.
>
> Read the source spec `a-reconfigure-is-not-an-outage` (`work/specs/tasked/`) before starting, and read
> `verdictFor` in the code before writing any `checkTxInclusion` test — the spec's own claim about it
> was wrong once and was corrected against the code.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED). If a
> dependency landed differently or an ADR superseded an assumption here, do NOT build on the stale
> premise — route to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a
> needs-attention signal").
>
> **The default is `on-catch-up` EVERYWHERE and there is deliberately no per-runtime default**, because
> the axis that would choose one (development versus production) is not detectable from inside a
> browser build. The dangerous value is opt-in.
>
> **Domain vocabulary.** *Promotion* is moving the canonical pointer to a successor; the *trigger* is
> the successor reaching the cursor the canonical generation had. *Drop-on-promotion* is discarding the
> superseded generation at that moment.
>
> **Where to look.** The canonical pointer and generation registry; the generation container; `lastSync`
> (`lastToBlock`, `latestBlock`) for the catch-up comparison; `verdictFor` / `checkTxInclusion` for the
> degradation behaviour.
>
> **Easy to get wrong:**
>
> - Picking a per-runtime default. The selecting axis is undetectable; that is why there is one default
>   everywhere.
> - Asserting `checkTxInclusion` on `status` alone. A `minedAtBlock` above the cursor answers `absent`
>   with basis `ahead-of-cursor`, because that branch is tested BEFORE window-not-covering.
> - Dropping the previous generation on an `immediate` promotion. That discards a complete state for an
>   empty one with no fallback; under `immediate` retention continues until the successor reaches the
>   old cursor.
>
> **Scope fence.** Do NOT build pause/resume. Do NOT build the progress reporting or the
> unavailable-stream fallback (that is `generation-progress-is-visible-and-a-bad-stream-degrades`). Do
> NOT change how a successor advances.
>
> Done means: reads never break across a reconfigure, the default is safe everywhere, `immediate` is
> opt-in and degrades honestly, and nothing is dropped on a promotion that demonstrated nothing.
