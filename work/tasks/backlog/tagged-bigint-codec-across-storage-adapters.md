---
title: Move every storage adapter onto a tagged BigInt codec instead of the "123n" guess
slug: tagged-bigint-codec-across-storage-adapters
covers: []
blockedBy: []
---

## What to build

One BigInt serialization codec, shared by every path that persists or serves a `LastSync`, that **identifies** a BigInt instead of **guessing** at one.

Five adapters plus the server currently encode a BigInt by suffixing its decimal form with `n` and decode by recognising that suffix: `ethereum-indexer-cli` (snapshot files), `ethereum-indexer-browser`'s `keepStateOnIndexedDB` and `keepStateOnLocalStorage`, `ethereum-indexer-fs`, `ethereum-indexer-db-utils` (PouchDB documents), and `ethereum-indexer-server`, which puts `bnReplacer` output straight into HTTP response bodies. The convention is **irreducibly ambiguous**: `"123n"` is what a `123n` BigInt serializes to AND a perfectly legal string for a contract to emit, so the decoder cannot tell them apart. Guessing wrong silently rewrites event data, and it is silent in both directions: a real BigInt read back as a string breaks arithmetic downstream, a string read back as a BigInt breaks comparisons (including `===` against a hash) and JSON round-trips.

`@ethereum-indexer/processor-sqlite` already solved this for its own `_sync` row and wrote down why (`src/sync.ts`): it tags instead, as `{__bigint__: "123"}`, an object with a single reserved key that no decoded event value can collide with. That is the fix shape. Extract it into the core next to `bnReplacer` / `bnReviver` / `isBigIntLiteral`, move every adapter onto it, and have `processor-sqlite` use the shared one rather than its private copy.

Two things to decide and record. **The read path**: whether the new decoder also accepts the legacy suffix form, and for how long. There are effectively no users and hash formats were already broken once (`535ccc1`), so "tagged only, no fallback" is defensible and simpler; accepting both means the ambiguity survives in the reader, which is the thing being removed. **The server's HTTP bodies**: an API that returns `{"__bigint__":"123"}` has moved the guess to the client rather than removed it, so decide whether the wire format is this codec, a plain decimal string with the type known from the ABI, or something else. That is an API decision, not a serialization detail, and it may deserve its own ADR.

Prior art and the reason this exists: `535ccc1` made all six copies of the old decoder stop THROWING on values that were never numbers (they tested a string's first and last character, then called `BigInt()` on the middle, so an ordinary base36 hash such as `1x9tbhn` threw from inside `JSON.parse` and the CLI read a good snapshot as corrupt), and made `simple_hash` prefix its digests so they can no longer land on the ambiguous shape. Both were containment. The convention itself was left as a guess, deliberately, and this task is that residue.

## Acceptance criteria

- [ ] One codec in the core, used by the CLI, both browser adapters, the fs adapter, `db-utils`, and `@ethereum-indexer/processor-sqlite`. No package keeps a private BigInt encoder or decoder.
- [ ] A round-trip test per adapter proving a `LastSync` holding BOTH real BigInt event args and strings that merely look like BigInts (`"123n"`, `"0n"`, `"-5n"`) comes back with every value's original TYPE intact. This is the assertion the old convention cannot pass.
- [ ] A contract-emitted string that reads like a BigInt literal survives a round trip as a string, in the same document as a real BigInt. (Pin it with a decoded `LogEvent` whose args carry both.)
- [ ] The legacy-form decision is implemented and recorded: either legacy suffix input is rejected/ignored outright, or it is accepted with a stated end date and a test for each form.
- [ ] The server's wire format decision is recorded (ADR if it changes the API's shape), and its response bodies match whatever was decided.
- [ ] Tests in each affected package's `test/`, vitest, and a changeset for every package whose serialization or API surface changed.

## Blocked by

- None, can start immediately.

## Prompt

> Replace the `"123n"` BigInt convention with a tagged codec across every storage adapter in the `ethereum-indexer` monorepo, so that decoding a persisted value stops being a guess.
>
> FIRST, check this task against current reality. It was written on 2026-08-21 after `535ccc1`, which centralised the old decoder's predicate as `isBigIntLiteral` in `ethereum-indexer/src/utils/bigint.ts` and made `simple_hash` prefix its digests with `h`. Confirm both still hold, and read `packages/processor-sqlite/src/sync.ts` (the module note explains the tagged form and why a suffix convention has to guess) plus `work/tasks/done/processor-version-hash-cannot-silently-lie.md`. If the codec has already moved, route to needs-attention rather than duplicating it.
>
> The problem is not that the old decoder crashed, that was fixed. The problem is that `"123n"` is both what a BigInt serializes to and a legal string a contract can emit, so the decoder cannot distinguish them and silently changes the type of whichever it gets wrong. `LastSync.unconfirmedBlocks` carries real decoded `LogEvent`s whose `args` hold a BigInt per `uint256`, and the same document carries `context` hashes, so both kinds genuinely coexist in one payload.
>
> Extract `processor-sqlite`'s tagged codec (`{__bigint__: "123"}`, a single reserved key) into the core beside the existing BigInt helpers, and move the CLI, `keepStateOnIndexedDB`, `keepStateOnLocalStorage`, the fs adapter, `db-utils` and `processor-sqlite` itself onto it. Note that `db-utils` and the js-processor's history use a DEEP walker rather than a `JSON.parse` reviver, so the codec needs both shapes or the walkers need converting.
>
> Two decisions are yours, and both must be recorded in a `## Decisions` block. Whether the reader still accepts the legacy suffix form at all (there are effectively no users, and accepting both keeps the ambiguity alive in the reader). And what `ethereum-indexer-server` puts on the wire, since it currently serves `bnReplacer` output directly in HTTP bodies: returning the tag moves the guess to the client rather than removing it, so if that changes the API's shape, write an ADR.
>
> Test per adapter, with a payload holding a real BigInt and a look-alike string together, asserting types and not just values. Add a changeset for every package whose serialization or API surface changed, and do not commit without confirmation.
