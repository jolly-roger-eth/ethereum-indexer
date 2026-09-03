---
title: 'A stream is identified by the digest of its filter, and that digest fills the address level'
slug: a-stream-is-identified-by-the-digest-of-its-filter
spec: a-reconfigure-is-not-an-outage
blockedBy: []
covers: [11]
---

## What to build

A stream is RESOLVED by what it contains, so two generations with different filters never collide and
one with the same filter is reused. Compute the real **stream digest** and write it into the address
level that `the-stream-appends-in-segments-on-indexeddb` deliberately left as a placeholder.

### The digest is over DEDUPLICATED `streamHash` VALUES, SORTED BY THEMSELVES

State it that precisely, because the obvious phrasing is wrong in a way that silently breaks the
spec's headline case. Per-source-entry, `streamHash` covers "what the FETCH FILTER is built from, and
nothing else" (address, `topic0`, block range). The entry LIST, however, is sorted by
`(startBlock, hash)` — and `hash` covers the DECODING shape. So a decode-only change (renaming a
non-indexed parameter, exactly the case the two-digest split exists for) REORDERS the list while every
`streamHash` in it is unchanged. A digest rolled up over the list in that order would move, fork a new
stream key, re-fetch the whole history and orphan the old stream, silently and with no error.

So: take the `streamHash` values ONLY, DEDUPLICATE them, sort them BY THEMSELVES, and digest that.
`hash` and `legacyHash` are excluded. Digesting whole entries has the same defect, worse.

### The digest ALSO covers the STREAM CONFIG hash

The filter is not the only thing that decides what a stream CONTAINS. `alwaysFetchTimestamps`,
`alwaysFetchTransactions` and `parse.filters` each change WHAT IS STORED. Keyed on the filter alone,
two different configs map to ONE stream, so a generation adopts logs the invalidation verdict has
already declared invalid — and the only existing remedy (clear the stream) destroys the stream the
live generation is still answering from.

Do NOT use `parse.logValues` as the worked example anywhere: it is an unused stub that
`the-stream-stores-only-what-the-node-said` deletes. The config hash keeps its full justification
without it.

This is a CORRECTION, not an innovation: ADR-0006 already keys the stored stream by `{source, config}`
and the state by `{source, config, processor}`. This digest is the concrete form of that ADR's
`{source, config}`, narrowed on the source side to the FETCH half per ADR-0034. Record the narrowing
where ADR-0008's differences are recorded rather than silently re-keying a stream ADR-0006 governs.

### The hash is WIDE and SYNCHRONOUS

As a change DETECTOR a collision costs one missed invalidation; as a KEY it means one generation
silently adopting another's stream under a filter that does not match it, so logs are missing and
nothing reports it. `simple_hash` is 32 bits — a coin-flip collision around 65,000 distinct filters.
Use a **128-bit synchronous** digest.

Use `viem`'s `sha256`, truncated: it is already a direct dependency of `@etherfold/core` and it is
SYNCHRONOUS. Do not reach for `crypto.subtle` (async, secure-context) and do not hand-roll or vendor a
digest. **One implementation, not a fast path with a fallback** — two implementations that must agree
BYTE FOR BYTE are a fork risk, and any difference in truncation or encoding gives different stream
addresses on different browsers, which is exactly the silent history-orphaning this digest prevents.

### Encoding, and what this task does NOT touch

The digest must be a value every substrate can carry as a KEY ELEMENT (a string on IndexedDB, a column
on SQL), so render it hex or base32, FIXED-LENGTH, so no rendering of one digest can be confused with
another.

**There is NO MIGRATION and no payload rewrite.** The address shape does not change; only what occupies
one level of it. Streams written under the placeholder are simply streams under a different digest:
unreachable by a filter that now resolves elsewhere, so nothing needs to MOVE. Their DISPOSAL is NOT
this task's — it is the unregistered-subtree sweep in
`generations-are-registered-and-one-pointer-is-canonical`, which is the only place that can know which
digests are registered.

**Add NO second discriminator and no composite-key type.** The `<indexer-name>` level ALREADY EXISTS
and is caller-supplied. Fill the DIGEST level; leave the name level exactly as found. Do not collapse
or hard-code it — the prerequisite's criteria assert that two names, and two chains, cannot see each
other's data, and those must not regress.

## Acceptance criteria

- [ ] A stream digest is derived from the DEDUPLICATED `streamHash` values sorted BY THEMSELVES, plus
      the stream config hash, and nothing else. `hash` and `legacyHash` are excluded.
- [ ] **The digest is STABLE UNDER A DECODE-ONLY CHANGE.** Rename a non-indexed ABI parameter and
      assert the digest does NOT move, even though every entry's `hash` changed and the entry list
      therefore reordered. This is the assertion that catches the ordering trap; a digest built over
      the sorted ENTRY list passes every other criterion here and fails this one.
- [ ] The digest is stable under ABI reordering and under a redundant appended entry.
- [ ] **The digest MOVES on a stream-config change**, and the old stream is left intact rather than
      adopted. Use `alwaysFetchTimestamps` or `alwaysFetchTransactions` as the worked example, NOT
      `parse.logValues`.
- [ ] The hash is 128-bit and SYNCHRONOUS, via `viem`'s `sha256` truncated. Assert no async digest and
      no second implementation exists. A collision cannot be produced across a corpus of realistic
      sources.
- [ ] The digest is rendered FIXED-LENGTH (hex or base32) and is usable as an IndexedDB key element.
- [ ] The real digest occupies the address level the prerequisite left as a placeholder, and the
      `<indexer-name>` level is untouched. Assert two indexer NAMES and two CHAINS still cannot see
      each other's data (the prerequisite's isolation must not regress).
- [ ] Nothing migrates or rewrites a payload; streams under the old placeholder are simply unreachable
      (their disposal belongs to the registry task).
- [ ] Ship a changeset for every published package whose surface changes.
- [ ] `pnpm build && pnpm typecheck && pnpm test` green.

## Blocked by

- None — can start immediately. (`the-stream-appends-in-segments-on-indexeddb`, which built the
  address and left the digest level as a placeholder, is already in `work/tasks/done/`.)

## Prompt

> Give a cached event stream a real IDENTITY: a digest of its fetch filter plus its stream config,
> filling the address level that the segmented-stream work left as a placeholder, in the `etherfold`
> monorepo.
>
> Read the source spec `a-reconfigure-is-not-an-outage` (`work/specs/tasked/`) and ADR-0006 (which
> already keys a stored stream by `{source, config}`) and ADR-0034 (the fetch/decode split) before
> starting. The done task `the-stream-appends-in-segments-on-indexeddb` built the hierarchical address
> `['stream', <indexer-name>, <digest>, <ordinal>]` with a PLACEHOLDER derived from `chainId` in the
> digest position; your job is to put the real value there.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED). If a
> dependency landed differently or an ADR superseded an assumption here, do NOT build on the stale
> premise — route to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a
> needs-attention signal").
>
> **Domain vocabulary.** A *stream* is identified by its FETCH FILTER (chain, addresses, topics,
> ranges) plus its stream config; a *generation* is a stream plus a processor and config, and is NOT
> this task. `streamHash` is the per-entry digest of the fetch filter only; `hash` additionally covers
> the DECODING shape, which is why it must not enter this digest or its ordering.
>
> **Where to look.** `eventRanges.ts` computes `streamHash` per source entry and sorts the entry list
> by `(startBlock, hash)`. The stream address and its key ranges are in the browser's IndexedDB stream
> keeper and the core segmented-stream helper. `viem`'s `sha256` is already a direct dependency of
> `@etherfold/core`.
>
> **Easy to get wrong:**
>
> - Digesting the sorted ENTRY LIST. A decode-only change reorders it while every `streamHash` is
>   unchanged, so the digest moves, forks a stream, re-fetches everything and orphans the old one —
>   silently. Deduplicate the `streamHash` values and sort them BY THEMSELVES.
> - Leaving the stream CONFIG out. Two configs would map to one stream and a generation would adopt
>   logs the verdict has declared invalid.
> - Using `simple_hash`. 32 bits is a coin-flip collision around 65,000 filters, and here a collision
>   is silent data loss rather than a missed invalidation.
> - Reaching for `crypto.subtle` (async, secure context) or adding a native fast path with a pure-JS
>   fallback. Two implementations that must agree byte for byte give different stream addresses on
>   different browsers.
> - Inventing a second tenancy discriminator. The `<indexer-name>` level already exists and is
>   caller-supplied; fill only the digest level.
>
> **Scope fence.** Do NOT build the generation registry, the canonical pointer or the caps (that is
> `generations-are-registered-and-one-pointer-is-canonical`). Do NOT sweep or delete placeholder-era
> subtrees — that sweep needs the registry and belongs to that task. Do NOT restate or re-specify the
> cursor contract; it is settled by `the-stream-appends-in-segments-on-indexeddb` and a second
> statement is a second source of truth. Do NOT add a server-side discriminator (that is
> `the-server-and-cli-hold-generations-too`).
>
> Done means: a filter change resolves to a different stream, a decode-only change does not, a config
> change does, and the address level carries a fixed-length digest with the name level untouched.

## Decisions

- **How the stream CONFIG reaches a keeper: an optional `setStreamConfig` on `ExistingStream`, called by `EthereumIndexer.reinit`.** The seam hands a keeper a `source` on every call and never the config, so a keeper that addresses a stream by `{filter, config}` could not compute its own address. Alternatives: (a) a `streamConfig` option on `keepStreamOnIndexedDB` — rejected because in the browser the keeper is constructed at `createIndexerState` and the config only arrives at `init`, so the value would be duplicated at the call site and could silently disagree with the config the indexer actually runs, which is precisely the failure this criterion exists to prevent; (b) an extra parameter on all three seam methods — rejected because it would have to be threaded through `createSegmentedStream` and all five `StreamSegmentPort` operations for the same effect; (c) handing over the computed DIGEST rather than the config — rejected because ADR-0035 leaves addressing to the keeper, and a keeper driven directly still has to address something. Putting it in `reinit` (not the constructor) is what makes a reconfigure follow onto the new stream while leaving the old subtree intact. **Touches:** `ExistingStream` (the IndexedDB keeper, `replayStream`, test fakes — all of which may ignore it), `EthereumIndexer.reinit`, and the later generation tasks, which will want several stream identities per keeper rather than one.
- **A keeper nobody has told runs at `resolveStreamConfig(undefined)`.** So a keeper driven directly (a test, a tool) addresses the same stream an indexer given no `stream` config addresses, rather than a fourth thing. The alternative — refusing until told — would make the keeper throw on a path that is a local cache, which `fetchFrom`'s no-throw rule forbids. **Touches:** anything constructing a keeper outside an indexer.
- **The config enters the preimage as canonical BYTES, not as `simple_hash(config)`.** CONTEXT.md and ADR-0008 say "plus the stream CONFIG hash"; that value is 32 bits, and a collision there maps two configs onto one stream — the exact silent adoption this task forbids. The digest is never compared against a stored `context.config`, so nothing needs the two to be the same bytes, and hashing the config directly is strictly stronger. The per-entry `streamHash` values stay as they are, because the task specifies them.
- **The preimage carries a rule tag (`etherfold/stream/1`).** A later change to what enters the digest is then a different digest by construction rather than by luck. It costs nothing and it is the same "unreachable, swept later" story the placeholder now has. **Touches:** the registry task's sweep, which collects orphans from a digest redefinition.
- **`streamAddress` changes signature from `(name, chainId)` to `(name, source, streamConfig)`,** and `placeholderStreamDigest` is deleted rather than kept beside it. It is exported from `@etherfold/browser`, so this is a published-surface break; nothing is published and the conventions doc says to delete the wrong thing rather than deprecate it beside the right one. The changeset carries it.
