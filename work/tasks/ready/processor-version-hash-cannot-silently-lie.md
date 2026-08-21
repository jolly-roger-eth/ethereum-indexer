---
title: A processor's version hash must not silently lie about its logic
slug: processor-version-hash-cannot-silently-lie
blockedBy: []
covers: []
---

## What to build

`getVersionHash()` is the only thing standing between a processor logic change and state computed by the *previous* logic being served forever. Today, for the live JS-object path, it is `` `${this.version || 'unknown'}-${this.configHash || 'not-configured'}` `` where `version` is an **optional, author-declared string** on the processor object. Two failure modes follow, both silent:

1. **The author never sets `version`.** The hash is then the literal constant `unknown-<configHash>`, so no logic change ever invalidates anything.
2. **The author changes handler code and forgets to bump `version`.** Same outcome.

Today the consequence is a stale snapshot being reused. Under `docs/adr/0008` it gets worse: a version change is what triggers the blue-green rebuild, so a missed bump means **the rebuild never runs** and the server keeps serving state derived from logic that no longer exists, with no cold start to rescue it.

Build two layers:

- **Make `version` mandatory.** Required in the `JSProcessor` type, and a runtime throw at construction if it is missing or empty, so the `unknown` constant becomes unreachable rather than merely discouraged. This is a breaking change to the authoring surface and needs a changeset.
- **Detect drift between the declared version and the actual code.** Derive a fingerprint from the processor's own handler implementations (the `on<Event>` functions, `construct`, and `handleUnparsedEvent`), persist it alongside the existing context in `lastSync`, and compare on load. If the **declared version matches but the fingerprint differs**, that is exactly the "forgot to bump" case: report it loudly.

The fingerprint is **advisory, not part of the version hash**. Including it in `getVersionHash()` would be safer in principle but would force a full rebuild whenever a bundler or minifier changes its output without any logic changing, which is an unacceptable cost on every deploy. Keeping it separate makes the false positive a warning rather than a multi-hour replay.

Default behaviour on drift is a loud error-level report that does not halt (the false-positive case is real: re-minification changes function source without changing behaviour), with an opt-in strict mode that refuses to start. Fail-loud by default, fail-stop by choice.

## Acceptance criteria

- [ ] A processor object with no `version` fails to construct, with a message naming the processor and saying why it is required.
- [ ] `getVersionHash()` can no longer return a string containing the `unknown` fallback (the fallback is removed, not just avoided).
- [ ] Changing a handler's implementation while keeping `version` fixed produces a drift report identifying which processor drifted.
- [ ] Changing `version` (with or without a code change) produces no drift report: a deliberate bump is never flagged.
- [ ] A byte-identical processor across restarts produces no drift report (the fingerprint is stable across process restarts, not merely within one).
- [ ] Strict mode turns the drift report into a refusal to start; default mode does not halt.
- [ ] Tests cover the new behaviour in the repo's vitest style, in `packages/ethereum-indexer-js-processor/test/`.
- [ ] A changeset records the breaking authoring-surface change.

## Blocked by

- None, can start immediately.

## Prompt

> Make a processor's version hash incapable of silently lying about its logic, in the `ethereum-indexer` monorepo.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have drifted): re-read `docs/adr/0008` and confirm the blue-green rebuild premise still holds, and check whether the historical-state / indexer-server work has landed since, which would change where the fingerprint is persisted. If a dependency landed differently, route to needs-attention rather than building on the stale premise.
>
> Context. `EventProcessor.getVersionHash()` is the processor-identity third of `ContextIdentifier` (`{source, config, processor}`); the core `load()` discards persisted state when it changes. For the live JS-object path (`fromJSProcessor`, the production path used by stratagems-world), that hash is built from an OPTIONAL author-declared `version` string with an `unknown` fallback, so a processor with no version, or one whose author forgot to bump it after editing a handler, is indistinguishable from an unchanged one. `docs/reviews/server-cli-batch.md` (HIGH-2, MEDIUM-3) already flags this; `docs/adr/0008` is what makes it load-bearing, because a version change is the trigger for the state rebuild.
>
> Do two things. (1) Make `version` mandatory: required in the `JSProcessor` type and enforced at construction, and delete the `unknown` fallback so it cannot be reached. (2) Add drift detection: fingerprint the processor's own handler implementations, persist it with the sync context, and on load compare. Declared version equal but fingerprint different is the "forgot to bump" case: report loudly at error level by default, and refuse to start under an opt-in strict mode. Do NOT fold the fingerprint into `getVersionHash()` itself: a bundler or minifier change would then force a full state rebuild with no logic change, which is why it stays advisory.
>
> Watch the stability requirement: the fingerprint must be identical across process restarts for identical code, or it produces a drift report on every boot. Test that explicitly, not just within a single process.
>
> Test at the `fromJSProcessor` seam in `packages/ethereum-indexer-js-processor/test/` (vitest, mirroring `reorg.test.ts`'s style). Add a changeset for the breaking authoring-surface change. Record any non-obvious in-scope decision durably per the work contract, and do not commit without confirmation.

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
