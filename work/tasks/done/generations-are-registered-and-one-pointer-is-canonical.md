---
title: 'Generations are registered, one pointer is canonical, a cap refuses, and unregistered subtrees are swept'
slug: generations-are-registered-and-one-pointer-is-canonical
spec: a-reconfigure-is-not-an-outage
blockedBy: [a-stream-is-identified-by-the-digest-of-its-filter]
covers: [4, 8, 9]
---

## What to build

The REGISTRY: creating a generation, moving the canonical pointer forward and back, refusing at a cap,
deleting a generation or a stream, and sweeping subtrees the registry does not know about. All of it
independently testable **with no indexer running** — this task builds the bookkeeping, not the
indexing.

A **generation** is a stream plus a fold over it, identified by its stream digest plus the `processor`
version hash. Config is already inside the stream digest, so naming it again here would be redundant.

### The canonical pointer

**One canonical pointer per indexer names the generation that answers reads.** Moving it IS the
promotion, and it is a single small record write, so promotion has no meaningful cost and no
multi-key recovery problem. **Moving it BACK is the revert** — which is story 4, and it is the whole
reason non-canonical generations are kept rather than evicted.

This task owns the pointer as a MECHANISM (move it, read it, move it back). It does NOT own the POLICY
that decides WHEN to move it automatically — that is `the-promotion-policy-moves-the-canonical-pointer`,
which needs a running indexer this task deliberately does not have.

### Two caps, and a cap REFUSES

Call them CAPS and never "retention". `retention` is pinned by ADR-0019 to a distance in BLOCK
NUMBERS; a generation cap is a COUNT. The two words will meet in one config object, so keep them
distinct.

- `maxStreams` per indexer bounds distinct filters.
- `maxGenerations` per indexer, as a **TOTAL and not per-stream**. Per-stream would let total growth
  scale with stream count, leaving the resource anyone actually cares about — total storage, total
  state stores — unbounded.

**Reaching either cap REFUSES the new generation and NAMES WHAT TO DELETE. It never evicts.** Eviction
picks a victim by a policy that cannot know which generation an operator was keeping deliberately, and
story 4 exists precisely because old generations have value. A refusal costs one operator action; a
wrong eviction costs a re-index.

**The cap is a CONFIGURED number and must NEVER be derived from `navigator.storage.estimate()`**, on
three measured grounds (`work/notes/findings/browser-storage-headroom-for-generations.md`): WebKit does
not implement it, `quota` varies four-fold between engines and moves between runs on one engine, and
with a real quota forced down to 8 MB it still reported 6.45 GB of headroom while writes were failing.
A pre-flight check against that number is worse than no check.

Defaults differ by runtime and this axis IS detectable (a package knows which it is): a server or CLI
should be generous, because keeping generations to inspect, A/B-test and revert is the point. A browser
default keeps the previous generation only until the new one is promoted — two generations transiently,
not N.

### Deleting, and reaping

**Deleting a generation is dropping its state store; deleting a stream is dropping its keyspace.** This
is cheap only because streams are self-contained. **A stream is reaped when its LAST generation goes.**

### The UNREGISTERED-SUBTREE SWEEP, and why it is here

`a-stream-is-identified-by-the-digest-of-its-filter` leaves placeholder-era subtrees unreachable but
does not delete them, and **the ordinary reaping rule cannot reach them**: reaping fires when a
stream's last GENERATION goes, and a subtree written before generations existed has no generation whose
departure can fire it. Nothing enumerates it, nothing deletes it, and it does not even count against
`maxStreams`, because the registry never learns of it. Left alone, every browser that ran the segmented
stream work and then upgrades keeps its entire pre-upgrade stream FOREVER — roughly 2 MB stored for the
31,332-log stratagems capture, more for a longer history — in the one runtime where storage headroom
is argued at length and `navigator.storage.estimate()` is refused.

This task is where the registry exists, so it is the only place that can answer "which digests are
known". Build the sweep as a **SCOPED LISTING of the `['stream', <indexer-name>]` level, dropping every
digest subtree with no generation in the registry.** Key it on "the registry does not know this digest",
NOT on a known placeholder value — that is what makes it generalise to an orphan from ANY cause,
including a later redefinition of the digest rule.

**Run it on registry OPEN rather than on a timer**, since that is the one moment the known set is
authoritative and nothing is mid-write.

### What creation owes the seeding spec

**Creating a generation takes its starting stream as an INPUT**: a generation does not assume it must
fetch its own history. Build creation backfill-only and
`a-generation-can-be-seeded-from-a-published-artifact` has to re-open the seam this split was made to
avoid. This is a real acceptance criterion here, not a note.

## Acceptance criteria

- [ ] A generation is created, registered, and identified by its stream digest plus the `processor`
      version hash. Creation takes its starting stream as an INPUT rather than assuming it fetches its
      own history.
- [ ] One canonical pointer per indexer names the generation that answers reads; moving it is a single
      small record write.
- [ ] **The pointer moves BACK**: after moving to a new generation, moving it to the previous one
      restores that generation's answers EXACTLY, with no re-indexing and no fetch (story 4).
- [ ] **A cap REFUSES and NAMES WHAT TO DELETE, and nothing is evicted.** Assert for both `maxStreams`
      and `maxGenerations`, and assert every existing generation is still readable after the refusal.
- [ ] `maxGenerations` is a TOTAL per indexer, not per-stream. Assert that adding streams does not
      raise the total generation ceiling.
- [ ] No cap is derived from `navigator.storage.estimate()`; assert the code never consults it.
- [ ] **Deleting a generation leaves its stream** if another generation uses it, and **reaps the stream
      when the last one goes** (story 9).
- [ ] **The unregistered-subtree sweep**, asserted against the case that creates it: write a stream
      under the previous PLACEHOLDER digest, bring up the registry, and assert the subtree is GONE and
      every live stream is untouched. Assert it is IDEMPOTENT and that it NEVER touches another indexer
      NAME's subtree. Assert it runs on registry open.
- [ ] Everything above is testable with NO indexer running.
- [ ] Ship a changeset for every published package whose surface changes.
- [ ] `pnpm build && pnpm typecheck && pnpm test` green.

## Blocked by

- `a-stream-is-identified-by-the-digest-of-its-filter` — the registry keys generations by the stream
  digest, and the sweep asks "which digests are registered", so the digest must exist and be real
  first.

## Prompt

> Build the GENERATION REGISTRY for the `etherfold` monorepo: create a generation, move a canonical
> pointer forward and back, refuse at a cap, delete a generation or a stream, and sweep stream subtrees
> the registry does not know about. All of it must be testable with NO indexer running.
>
> Read the source spec `a-reconfigure-is-not-an-outage` (`work/specs/tasked/`), ADR-0008 (the
> blue/green rebuild this generalises), ADR-0019 (retention is a distance in BLOCK NUMBERS — a
> generation cap is a COUNT and a different object) and
> `work/notes/findings/browser-storage-headroom-for-generations.md` before starting.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED). If a
> dependency landed differently or an ADR superseded an assumption here, do NOT build on the stale
> premise — route to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a
> needs-attention signal").
>
> **Domain vocabulary.** A *generation* is a stream plus a fold over it, identified by its stream
> digest plus the processor version hash. The *canonical pointer* names the generation that answers
> reads; moving it is promotion, moving it back is revert. A *cap* is a COUNT of generations or
> streams and REFUSES; *retention* is a block distance and is a different thing entirely.
>
> **Where to look.** The stream address and its scoped key ranges are in the browser's IndexedDB
> keeper and the core segmented-stream helper (both already hierarchical, which is what makes a scoped
> listing of one level cheap). The state stores each generation drops live behind the `StateStore`
> seam.
>
> **Easy to get wrong:**
>
> - Evicting instead of refusing. Story 4 exists because old generations have value; a policy cannot
>   know which one the operator was keeping.
> - Making `maxGenerations` per-stream, which leaves total storage unbounded as streams accumulate.
> - Trusting `navigator.storage.estimate()`. It is unimplemented on WebKit and reported 6.45 GB of
>   headroom while writes were failing against a forced 8 MB quota.
> - Keying the sweep on the known placeholder value. Key it on "the registry does not know this
>   digest" so it also collects orphans from a later digest redefinition.
> - Running the sweep on a timer. Run it on registry open, the one moment the known set is
>   authoritative and nothing is mid-write.
> - Building creation as fetch-its-own-history. It must take its starting stream as an INPUT.
>
> **Scope fence.** Do NOT build the promotion POLICY, its three values or its trigger (that is
> `the-promotion-policy-moves-the-canonical-pointer`, which needs a running indexer). Do NOT build the
> container, the indirect handle or the factory migration. Do NOT make a non-canonical generation
> ADVANCE. Do NOT restate the cursor contract. Do NOT add a server/CLI tenancy discriminator (that is
> `the-server-and-cli-hold-generations-too`).
>
> Done means: generations can be created, pointed at, reverted to, refused at a cap, and deleted; and a
> placeholder-era subtree is swept on registry open without touching a live stream or another indexer
> name.

## Decisions

- **The FIRST generation created becomes canonical; a successor does not.** A registry that holds generations and points at none answers nothing, and every value the promotion policy will take (`on-catch-up`, `immediate`, `manual`) presupposes an incumbent before it has a question. Alternative considered: leave the pointer unset until an explicit `moveCanonicalTo`, which is purer mechanism but makes every caller special-case "first" and would make a `manual` deployment answer nothing until a human acted. **Touches** `the-promotion-policy-moves-the-canonical-pointer`: that task still owns the incumbent-versus-successor decision entirely; nothing here moves the pointer to a successor.
- **Deleting the canonical generation (or its stream) is REFUSED, not allowed with the pointer cleared.** New refusal `GenerationIsCanonicalError`: move the pointer first, which is one write. Deleting what answers reads blanks the app for a re-index, which is the outage this design exists to remove. Alternative: clear the pointer on delete, which leaves an indexer holding generations and naming none. Consequence: there is no way to empty an indexer completely through the registry; that is deliberate and can be revisited by whichever task owns tearing an indexer down.
- **Deleting a generation or stream the registry does not hold is REFUSED, not a silent no-op.** New refusals `UnknownGenerationError` / `UnknownStreamError`. The cap refusal NAMES what to delete, so a mistyped name coming back silently successful is the wrong answer to give an operator about a destructive call. **Touches** any future CLI/admin verb that wraps deletion: it must expect a throw rather than a count of zero.
- **`dropState` is INJECTED and required, not derived.** The registry does not know where a generation's state store lives and does not invent a database-naming convention: the container above `StateStore` (`the-generation-container-expands-beside-the-old-shape`) owns that, and it is inside this task's scope fence. Alternative considered: have the browser registry default to deleting an IndexedDB database named by a convention chosen here, which would fork a convention the container task must then either adopt or contradict. **Touches** tasks 4-6.
- **The record goes before the bytes on delete.** Registry commit, then `dropState`, then the stream subtree. A crash between them LEAKS storage; the other order leaves the registry claiming a generation whose state is gone. The leak is collected by the sweep on the next open, which is the same mechanism the placeholder case needs.
- **The sweep has no public entry point.** `openGenerationRegistry` runs it and exposes `swept` as a value. There is deliberately no `registry.sweep()`, so "run it on open, not on a timer" is structural rather than documentary. Cost: a caller who wants a sweep re-opens the registry.
- **Browser default caps are 2 and 2** (`BROWSER_GENERATION_CAPS`), a user-visible default: the previous generation and the new one, transiently. Core requires the caps explicitly and defaults nothing, so the server/CLI's generous values stay `the-server-and-cli-hold-generations-too`'s to set.
- **The stream `subtree` key range's lower bound widened** from ordinal `0` to the prefix itself (exclusive), so the range spans every key under a digest whatever its last element is. The sweep drops subtrees written by code that is gone, and assuming a dead digest rule's key shape is exactly the assumption that leaves bytes behind. It makes the existing `clearSubtree` strictly more complete; no behaviour any test pinned has changed.

No ADR: none of these meets the hard-to-reverse-plus-surprising bar on its own, and the model they implement is already recorded in ADR-0008's 2026-08-31 amendment and in the `CONTEXT.md` glossary entries for **generation**, **canonical pointer** and **generation cap**, whose language I reused rather than extended. The only new named concepts are the two refusals and `BROWSER_GENERATION_CAPS`.
