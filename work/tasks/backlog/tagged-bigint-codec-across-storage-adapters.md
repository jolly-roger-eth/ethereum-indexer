---
title: Move every storage adapter onto a tagged BigInt codec instead of the "123n" guess
slug: tagged-bigint-codec-across-storage-adapters
covers: []
blockedBy: []
---

## What to build

One BigInt serialization codec, shared by every path that persists or serves a `LastSync`, that **identifies** a BigInt instead of **guessing** at one.

> **READ FIRST — re-scoped 2026-08-24, because three of this task's premises drifted.** It was written 2026-08-21; since then `clear-the-release-path-and-archive-the-old-names` and `backend-neutral-entity-event-processor` landed. **(1)** The codec this task says to extract is no longer in `@etherfold/processor-sqlite/src/sync.ts` — it moved to `@etherfold/processor-entities/src/cursor.ts`, and `sync.ts` is now 37 lines of re-exports. **(2)** Two of the six named consumers, `ethereum-indexer-db-utils` and `ethereum-indexer-server`, are in `archive/`, which is outside the `pnpm-workspace.yaml` globs — so the PouchDB deep-walker and the HTTP wire-format decision are both out of scope now. **(3)** Two consumers exist that this task never named: `packages/core/src/stream/fixture.ts` and `packages/conformance-workload-stratagems/src/fixtures.ts`. The lists below are corrected; confirm them again before starting, since the drift-check in the prompt is what caught this.

The adapters that currently encode a BigInt by suffixing its decimal form with `n` and decode by recognising that suffix, **as they stand in the workspace today**: `@etherfold/cli` (`src/utils/bn.ts`, `src/keepState.ts`, the snapshot files), `@etherfold/browser`'s `keepStateOnIndexedDB` and `keepStateOnLocalStorage` (`src/storage/state/OnIndexedDB.ts`, `OnLocalStorage.ts`), `@etherfold/fs` (`src/utils/json.ts`, `src/utils/fs.ts`), `@etherfold/core`'s stream fixture (`src/stream/fixture.ts`), and `@etherfold/conformance-workload-stratagems` (`src/fixtures.ts`). The helpers themselves live in `@etherfold/core/src/utils/bigint.ts`. The convention is **irreducibly ambiguous**: `"123n"` is what a `123n` BigInt serializes to AND a perfectly legal string for a contract to emit, so the decoder cannot tell them apart. Guessing wrong silently rewrites event data, and it is silent in both directions: a real BigInt read back as a string breaks arithmetic downstream, a string read back as a BigInt breaks comparisons (including `===` against a hash) and JSON round-trips.

**The fix shape already exists, and it moved.** It is `@etherfold/processor-entities/src/cursor.ts`, which tags a BigInt as `{__bigint__: "123"}` — an object with a single reserved key that no decoded event value can collide with — and whose module note explains why a suffix convention has to guess. It got there via `backend-neutral-entity-event-processor`: the sync cursor moved behind the storage seam as an opaque string (ADR-0027), so the old `_sync (id, lastSync)` table became `_cursor (key, value)` in `@etherfold/state-store-sqlite` and the codec went with the processor rather than the storage. Extract THAT into the core next to `bnReplacer` / `bnReviver` / `isBigIntLiteral`, move every adapter above onto it, and have `processor-entities` use the shared one rather than its own copy. (`@etherfold/processor-entities` already depends on `@etherfold/core`, so this direction adds no cycle; the store packages must NOT gain a core dependency, which is what ADR-0018 and `no-platform-leakage.test.ts` pin.)

One thing to decide and record. **The read path**: whether the new decoder also accepts the legacy suffix form, and for how long. There are effectively no users and hash formats were already broken once (`535ccc1`), so "tagged only, no fallback" is defensible and simpler; accepting both means the ambiguity survives in the reader, which is the thing being removed.

**The server's HTTP wire format is NO LONGER part of this task**, and that is a scope reduction rather than an oversight. It applied to `ethereum-indexer-server`, which put `bnReplacer` output straight into response bodies and is now archived. The current `@etherfold/server` serves no BigInt-bearing payload (nothing in `packages/server/src` touches `bnReplacer`/`bnReviver`), and `ingest-wire-receiving-side` carries RAW logs — hex strings, decoded server-side — so the question does not arise there either. Re-open it as its own decision (with the ADR it was said to deserve) the first time an HTTP surface here serves a decoded `LogEvent`; do not settle an API shape in this task for a consumer that does not exist.

Prior art and the reason this exists: `535ccc1` made all six copies of the old decoder stop THROWING on values that were never numbers (they tested a string's first and last character, then called `BigInt()` on the middle, so an ordinary base36 hash such as `1x9tbhn` threw from inside `JSON.parse` and the CLI read a good snapshot as corrupt), and made `simple_hash` prefix its digests so they can no longer land on the ambiguous shape. Both were containment. The convention itself was left as a guess, deliberately, and this task is that residue.

## Acceptance criteria

- [ ] One codec in the core, used by the CLI, both browser adapters, the fs adapter, the core's own stream fixture, the stratagems conformance workload, and `@etherfold/processor-entities`. No package in the workspace keeps a private BigInt encoder or decoder. (`archive/` is out of the workspace and is not touched.)
- [ ] A round-trip test per adapter proving a `LastSync` holding BOTH real BigInt event args and strings that merely look like BigInts (`"123n"`, `"0n"`, `"-5n"`) comes back with every value's original TYPE intact. This is the assertion the old convention cannot pass.
- [ ] A contract-emitted string that reads like a BigInt literal survives a round trip as a string, in the same document as a real BigInt. (Pin it with a decoded `LogEvent` whose args carry both.)
- [ ] The legacy-form decision is implemented and recorded: either legacy suffix input is rejected/ignored outright, or it is accepted with a stated end date and a test for each form.
- [ ] The sync cursor still round-trips on every backend after the move. `@etherfold/state-store` still declares NO dependencies and `no-platform-leakage.test.ts` still passes: the codec belongs to the processor, and the store persists a string it does not interpret (ADR-0027).
- [ ] The captured stream fixture still parses and replays byte-identically, and the stratagems workload still reproduces its golden state. These two are the reason the codec change is not free: they are committed artifacts, so a change of encoding is a change to files on disk, and whether they are regenerated or read with a compatibility path is part of the legacy-form decision above.
- [ ] Tests in each affected package's `test/`, vitest, and a changeset for every package whose serialization or API surface changed.

## Blocked by

- None, can start immediately.

## Prompt

> Replace the `"123n"` BigInt convention with a tagged codec across every storage adapter in the `etherfold` monorepo, so that decoding a persisted value stops being a guess.
>
> FIRST, check this task against current reality. It was written on 2026-08-21 after `535ccc1`, which centralised the old decoder's predicate as `isBigIntLiteral` in `core/src/utils/bigint.ts` and made `simple_hash` prefix its digests with `h`. Confirm both still hold, and read `packages/processor-entities/src/cursor.ts` (the module note explains the tagged form and why a suffix convention has to guess) plus `work/tasks/done/processor-version-hash-cannot-silently-lie.md` and ADR-0027. The task body carries a READ FIRST block recording a re-scope on 2026-08-24: the codec moved out of `processor-sqlite/src/sync.ts`, two named consumers were archived, and two unnamed ones appeared. Confirm that block still describes reality before you start, and route to needs-attention if it does not.
>
> The problem is not that the old decoder crashed, that was fixed. The problem is that `"123n"` is both what a BigInt serializes to and a legal string a contract can emit, so the decoder cannot distinguish them and silently changes the type of whichever it gets wrong. `LastSync.unconfirmedBlocks` carries real decoded `LogEvent`s whose `args` hold a BigInt per `uint256`, and the same document carries `context` hashes, so both kinds genuinely coexist in one payload.
>
> Extract `processor-entities`' tagged codec (`{__bigint__: "123"}`, a single reserved key) into the core beside the existing BigInt helpers, and move the CLI, `keepStateOnIndexedDB`, `keepStateOnLocalStorage`, the fs adapter, the core's stream fixture, the stratagems workload and `processor-entities` itself onto it. Note that the js-processor's history uses a DEEP walker rather than a `JSON.parse` reviver, so the codec needs both shapes or the walker needs converting.
>
> ONE decision is yours and must be recorded in a `## Decisions` block: whether the reader still accepts the legacy suffix form at all (there are effectively no users, and accepting both keeps the ambiguity alive in the reader). The server's wire format is NOT yours — it left this task with the archived `ethereum-indexer-server`; see the body.
>
> Watch the two COMMITTED artifacts: the captured stream fixture and the stratagems golden state are files on disk in the encoding you are changing. Decide explicitly whether they are regenerated or read through a compatibility path, and prove the workload still reproduces its golden state either way.
>
> Test per adapter, with a payload holding a real BigInt and a look-alike string together, asserting types and not just values. Add a changeset for every package whose serialization or API surface changed, and do not commit without confirmation.
