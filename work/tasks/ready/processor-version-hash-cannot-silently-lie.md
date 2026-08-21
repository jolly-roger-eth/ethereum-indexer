---
title: A processor's version hash must not silently lie about its logic
slug: processor-version-hash-cannot-silently-lie
blockedBy: []
covers: []
---

> **Re-scoped 2026-08-21**, after `sql-backed-event-processor` landed. The task was written when the JS-object processor was the only `EventProcessor` implementation. There are now two, the second reproduced the same `unknown` fallback on the day it was written, and the "where is the fingerprint persisted" question the original prompt told the builder to re-check now has two different answers. The failure modes and the chosen design are unchanged; the surface they apply to is wider. What changed is marked inline.

## What to build

`getVersionHash()` is the only thing standing between a processor logic change and state computed by the *previous* logic being served forever. Today it is an **optional, author-declared string** with a fallback, in **both** implementations:

| implementation | `getVersionHash()` today |
| --- | --- |
| `JSObjectEventProcessor` (`ethereum-indexer-js-processor`) | `` `${version \|\| 'unknown'}-${configHash \|\| 'not-configured'}` `` |
| `VersionedStateEventProcessor` (`@ethereum-indexer/processor-sqlite`) | `` `${version \|\| 'unknown'}-${simple_hash(entities)}-${configHash \|\| 'not-configured'}` `` |

Two failure modes follow, both silent, and both present in both:

1. **The author never sets `version`.** The hash is then a constant containing `unknown`, so no logic change ever invalidates anything.
2. **The author changes handler code and forgets to bump `version`.** Same outcome.

Today the consequence is a stale snapshot being reused. Under `docs/adr/0008` it gets worse: a version change is what triggers the blue-green rebuild, so a missed bump means **the rebuild never runs** and the server keeps serving state derived from logic that no longer exists, with no cold start to rescue it.

**The SQL path is partially, accidentally protected and that is not a substitute.** It folds the entity declarations into the hash, so a *schema* change invalidates without a version bump. Handler changes — the actual subject of this task — do not, because handlers are functions and the declarations are data. Treat it as a precedent for deriving part of the identity rather than declaring it, not as the problem being half-solved.

Build two layers, **across both implementations**:

- **Make `version` mandatory.** Required in the `JSProcessor` **and `SQLProcessor`** types, and a runtime throw at construction if it is missing or empty, so the `unknown` constant becomes unreachable rather than merely discouraged. This is a breaking change to two authoring surfaces and needs a changeset covering both packages.
- **Detect drift between the declared version and the actual code.** Derive a fingerprint from the processor's own handler implementations (the `on<Event>` functions, and `construct` / `handleUnparsedEvent` where the implementation has them), persist it alongside the existing context, and compare on load. If the **declared version matches but the fingerprint differs**, that is exactly the "forgot to bump" case: report it loudly.

The fingerprint is **advisory, not part of the version hash**. Including it in `getVersionHash()` would be safer in principle but would force a full rebuild whenever a bundler or minifier changes its output without any logic changing, which is an unacceptable cost on every deploy. Keeping it separate makes the false positive a warning rather than a multi-hour replay.

> **Know that this deviates from ADR-0008, deliberately.** That ADR says deriving the hash from the processor bundle itself "is a requirement of this design and not a follow-up" — i.e. it asks for exactly the folding-in that the paragraph above rejects. The rejection is on cost, and it is the reason this task exists in this shape rather than as "derive the hash from the bundle". Do not silently resolve the tension either way: build it advisory as specified, and record the deviation in your `## Decisions` block so a reviewer can ratify it or send it back. If it is ratified, ADR-0008's consequence bullet should be amended to match.

Default behaviour on drift is a loud error-level report that does not halt (the false-positive case is real: re-minification changes function source without changing behaviour), with an opt-in strict mode that refuses to start. Fail-loud by default, fail-stop by choice.

### Where the fingerprint is persisted (the drifted premise)

The original task said "persist it alongside the existing context in `lastSync`". That is still the right home, but it is no longer one place, and `ContextIdentifier` is a **core** type (`{source, config, processor}` in `packages/ethereum-indexer/src/types.ts`), so widening it touches the core and both implementations at once:

- **JS path:** `lastSync` is persisted only if a `KeepState` keeper is configured. A processor with no keeper has nowhere to write a fingerprint, so drift detection is a no-op there — decide whether that is acceptable (it is the in-browser case, which does usually have a keeper) or whether the absence should itself be reported.
- **SQL path:** `lastSync` is always persisted, as one row in the `_sync` table owned by `@ethereum-indexer/processor-sqlite`, serialized with a BigInt-tagged JSON codec. A new field rides along for free, but note the codec: a fingerprint must survive that round-trip unchanged.

Decide whether the fingerprint belongs **in** `ContextIdentifier` (one core change, both paths inherit it, and every existing persisted cursor lacks the field so absence must mean "unknown, do not report" rather than "drifted") or **beside** it in each implementation's own storage. Record the choice.

## Acceptance criteria

- [ ] A processor object with no `version` fails to construct, with a message naming the processor and saying why it is required. **Both implementations**: `JSProcessor` and `SQLProcessor`.
- [ ] `getVersionHash()` can no longer return a string containing the `unknown` fallback, in **either** implementation (the fallback is removed, not just avoided).
- [ ] Changing a handler's implementation while keeping `version` fixed produces a drift report identifying which processor drifted.
- [ ] Changing `version` (with or without a code change) produces no drift report: a deliberate bump is never flagged.
- [ ] A byte-identical processor across restarts produces no drift report (the fingerprint is stable across process restarts, not merely within one).
- [ ] An existing persisted cursor written before this change (no fingerprint field) produces no drift report: absence means "unknown", never "drifted". Otherwise every upgrade reports drift once, and the report stops being believed.
- [ ] Strict mode turns the drift report into a refusal to start; default mode does not halt.
- [ ] The SQL path's fingerprint survives the `_sync` codec round-trip unchanged (it is not plain `JSON.stringify`; see `packages/processor-sqlite/src/sync.ts`).
- [ ] Tests cover the new behaviour in the repo's vitest style, in `packages/ethereum-indexer-js-processor/test/` **and** `packages/processor-sqlite/test/`.
- [ ] A changeset records the breaking authoring-surface change, covering **every** package whose authoring surface changed.

## Blocked by

- None, can start immediately.

## Prompt

> Make a processor's version hash incapable of silently lying about its logic, in the `ethereum-indexer` monorepo.
>
> FIRST, check this task against current reality. It was re-scoped on 2026-08-21 after `sql-backed-event-processor` landed, so the drift that re-scope fixed is already reflected here; verify it is still accurate rather than assuming. Re-read `docs/adr/0008` (the blue-green rebuild premise, which held at re-scope time) and read `work/tasks/done/sql-backed-event-processor.md`, whose `## Decisions` block records why the SQL processor hashes its entity declarations and how its `_sync` cursor is stored. If something landed differently again, route to needs-attention rather than building on the stale premise.
>
> Context. `EventProcessor.getVersionHash()` is the processor-identity third of `ContextIdentifier` (`{source, config, processor}`); the core `load()` discards persisted state when it changes. There are TWO implementations: `JSObjectEventProcessor` via `fromJSProcessor` (the production path used by stratagems-world) and `VersionedStateEventProcessor` in `@ethereum-indexer/processor-sqlite`. Both build that hash from an OPTIONAL author-declared `version` string with an `unknown` fallback, so a processor with no version, or one whose author forgot to bump it after editing a handler, is indistinguishable from an unchanged one. The SQL one additionally hashes its entity declarations, which catches schema changes but NOT handler changes, so it is a precedent for deriving identity rather than a partial fix. `docs/reviews/server-cli-batch.md` (HIGH-2, MEDIUM-3) already flags the underlying problem; `docs/adr/0008` is what makes it load-bearing, because a version change is the trigger for the state rebuild.
>
> Do two things, in BOTH implementations. (1) Make `version` mandatory: required in the `JSProcessor` and `SQLProcessor` types and enforced at construction, and delete the `unknown` fallback so it cannot be reached. (2) Add drift detection: fingerprint the processor's own handler implementations, persist it with the sync context, and on load compare. Declared version equal but fingerprint different is the "forgot to bump" case: report loudly at error level by default, and refuse to start under an opt-in strict mode. Do NOT fold the fingerprint into `getVersionHash()` itself: a bundler or minifier change would then force a full state rebuild with no logic change, which is why it stays advisory. Note that this DEVIATES from ADR-0008, which asks for exactly that folding-in and calls it a requirement; build it advisory as specified and record the deviation in your `## Decisions` block rather than resolving the tension silently.
>
> Decide where the fingerprint lives, and record it: inside `ContextIdentifier` (a core type change both paths inherit) or beside it in each implementation's own storage. Mind that the two paths persist differently — the JS path only when a `KeepState` keeper is configured, the SQL path always, through the BigInt-tagged codec in `packages/processor-sqlite/src/sync.ts`.
>
> Watch two stability requirements. The fingerprint must be identical across process restarts for identical code, or it produces a drift report on every boot; test that explicitly, not just within a single process. And a cursor persisted BEFORE this change has no fingerprint at all: absence must read as "unknown", never as drift, or every existing deployment reports drift once on upgrade and the report stops being believed.
>
> Test at the `fromJSProcessor` seam in `packages/ethereum-indexer-js-processor/test/` and at the equivalent seam in `packages/processor-sqlite/test/` (vitest, mirroring `reorg.test.ts`'s style in each). Add a changeset covering every package whose authoring surface changed. Record any non-obvious in-scope decision durably per the work contract, and do not commit without confirmation.

---

### Claiming this task

```sh
# atomically claim it (works with a GitHub remote OR a local --bare remote):
dorfl claim processor-version-hash-cannot-silently-lie --arbiter <remote>
# then start work on the updated main:
git fetch <remote> && git switch -c work/processor-version-hash-cannot-silently-lie <remote>/main
# on completion, in the work branch's PR/merge:
git mv work/tasks/ready/processor-version-hash-cannot-silently-lie.md work/tasks/done/processor-version-hash-cannot-silently-lie.md
```
