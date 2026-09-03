---
title: 'A reconfigure hashes the RESOLVED stream config everywhere, so an unset default is not a full re-index'
slug: a-reconfigure-hashes-the-resolved-stream-config-everywhere
promotedFrom: observation:updateindexer-hashes-the-provided-stream-config-not-the-resolved-one
blockedBy: []
covers: []
---

## What to build

Make the stream-config hash mean ONE thing. Today two call sites disagree about which form of the
config they digest, so a reconfigure that changes nothing reports the stream as invalid, discards the
state and re-fetches the entire history from the node. That is the outage
`a-reconfigure-is-not-an-outage` exists to remove, reachable through the very verb that spec's
reconfigure path runs on.

The two sites, both in `packages/core/src/indexer.ts`:

- `reinit` stores `this.streamConfigHash = simple_hash(this.config.stream || 'undefined')`, where
  `this.config.stream` has been through `resolveStreamConfig` and therefore always carries
  `finality` (the default is `17`).
- `updateIndexer` computes `const newConfigHash = update.streamConfig ? simple_hash(update.streamConfig) : this.streamConfigHash`,
  on the config exactly as the CALLER passed it.

### Why this is worse than the observation that promoted it

The note that prompted this task says "re-passing an unchanged config can force a full re-index". The
real blast radius is wider, and the task should be built against the wider claim: **the stored hash
always includes `finality`, so ANY `updateIndexer({streamConfig})` from a caller that omits it
produces a hash that cannot match, whatever else the caller changed or did not change.** Omitting
`finality` is not an edge case — `resolveStreamConfig` exists precisely because callers leave it
unset, and a caller passing `{alwaysFetchTimestamps: true}` is passing a perfectly ordinary config.

The consequence chain is worth stating because it is what makes this urgent rather than untidy:
`sourceInvalidationOf` reports `reason: 'stream-config'`, and a stream-config move invalidates the
STREAM half from block 0, not just the state half. So the cached stream is cleared and every log is
re-fetched from the node, for a reconfigure that may have changed nothing observable.

### How it came to be, worth recording in the fix

A partial migration. `resolveStreamConfig` was introduced after `updateIndexer`'s hash line existed,
and only one of the two call sites moved onto it. The asymmetry surfaced when
`a-stream-is-identified-by-the-digest-of-its-filter` had to decide EXPLICITLY which form entered the
stream digest (it takes the resolved one, deliberately, so that an unset `finality` and the default
written out address one stream). The lesson for the fix: the resolved form is the canonical one
everywhere, and the fix should make a second divergence hard rather than merely correcting this one.

## What this is NOT

- **NOT a change to what `resolveStreamConfig` fills in**, and not a change to the default `finality`
  of 17. The resolver is correct; the callers of the hash are not.
- **NOT a change to the stream DIGEST.** `streamDigestOf` already takes the resolved config and is
  right; do not re-key stored streams, and do not touch `simple_hash`'s canonicalisation
  (`canonical_form` is shared with the digest and its bytes are persisted).
- **NOT a change to what a genuine stream-config change does.** A config that really moved must still
  invalidate the stream half from block 0. The bug is a FALSE positive, not the rule.

## Acceptance criteria

- [ ] **The regression is pinned FIRST and fails before the fix**: an indexer initialised with a
      stream config that omits `finality`, then `updateIndexer({streamConfig})` passing an EQUIVALENT
      config that also omits it, reports both halves VALID, discards no state and re-fetches nothing.
      Assert on ranges fetched AND state discarded, the ADR-0034 pair.
- [ ] The same assertion for a config that omits `finality` while CHANGING something else harmless,
      so the fix is not "equal objects compare equal" but "the resolved forms are compared".
- [ ] A config that genuinely moves (`alwaysFetchTimestamps`, `alwaysFetchTransactions`,
      `parse.filters`, or an explicitly different `finality`) still invalidates the stream half from
      block 0, asserted, so the false positive is removed without removing the true one.
- [ ] Passing `{finality: 17}` explicitly and leaving it unset are ONE config to this comparison,
      exactly as they are one stream to `streamDigestOf`.
- [ ] **The two call sites cannot diverge again**: the resolve-then-hash step exists in exactly one
      place that both `reinit` and `updateIndexer` go through, and a test asserts there is no second
      site hashing a `ProvidedStreamConfig`. A comment alone does not satisfy this.
- [ ] `streamDigestOf` and every stored digest are unchanged: no stream is re-keyed and
      `simple_hash`/`canonical_form` are byte-for-byte untouched, asserted.
- [ ] The published verdict (`ReconfigureOutcome.sourceInvalidation`) reports the corrected answer, so
      a caller acting on the verdict sees `{state: {valid: true}, stream: {valid: true}}` on the
      no-op case.
- [ ] Ship a changeset for every published package whose surface changes.
- [ ] `pnpm build && pnpm typecheck && pnpm test` green.

## Blocked by

- None.

## Prompt

> Fix a bug in the etherfold engine that turns an ordinary reconfigure into a full re-index: two call
> sites hash the stream config in different forms, so an unset `finality` makes the stored hash and the
> incoming one disagree for ever.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does
> it still match the code, the tasks in `work/tasks/done/`, and the relevant ADRs (0006 on what keys a
> stream, 0034 on the fetch/decode split and the free append, 0008's amendment on the narrowing)? If a
> dependency landed differently, do not build on the stale premise — route to needs-attention with the
> discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> The behaviour required is settled: the RESOLVED stream config is the canonical form everywhere, so an
> unset `finality` and the default written out are one config, exactly as they are already one stream
> to `streamDigestOf`. What is open is only where the single resolve-then-hash step should live.
>
> The defect, both sites in `packages/core/src/indexer.ts`: `reinit` hashes `this.config.stream`, which
> `resolveStreamConfig` has filled, so the stored `context.config` always includes `finality`.
> `updateIndexer` hashes `update.streamConfig` as PROVIDED. Since the stored hash always carries
> `finality` and a caller usually does not pass it, the two can never match, `sourceInvalidationOf`
> reports `reason: 'stream-config'`, and a stream-config move invalidates the STREAM half from block 0
> — so the cached stream is cleared and the whole history is re-fetched from the node for a reconfigure
> that changed nothing.
>
> Where to work: `packages/core`. Write the failing test FIRST: initialise with a config omitting
> `finality`, index to the tip, then `updateIndexer` with an equivalent config that also omits it, and
> assert nothing was discarded and no range was re-fetched. Confirm it is red before the fix.
>
> Hard constraints. (1) Do NOT change `resolveStreamConfig` or the default `finality` of 17 — the
> resolver is right, its callers are not. (2) Do NOT touch `simple_hash` or the shared `canonical_form`:
> those bytes are persisted, and the stream digest shares them. (3) Do NOT re-key any stored stream:
> `streamDigestOf` already takes the resolved config and is correct. (4) A config that GENUINELY moved
> must still invalidate the stream half from block 0; you are removing a false positive, not the rule.
>
> Make a second divergence hard rather than just fixing this one: put the resolve-then-hash step in ONE
> place both verbs go through, and assert with a test that no second site hashes a provided config.
>
> Done means: an equivalent-but-unresolved config is a no-op reconfigure (nothing discarded, nothing
> re-fetched, both verdict halves valid), a real config change still invalidates from block 0, and the
> two call sites are structurally one.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT — in
> particular where you put the single hashing step and what you did to keep a third caller from
> reintroducing the split.
