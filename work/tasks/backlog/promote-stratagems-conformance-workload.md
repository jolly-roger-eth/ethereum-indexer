---
title: Promote the spike's captured stream, golden state and port into the conformance workload
slug: promote-stratagems-conformance-workload
spec: one-processor-everywhere
blockedBy: [state-store-conformance-suite, bounded-id-prefix-listing]
covers: [13]
---

## What to build

Turn three committed spike artifacts into the conformance suite's real workload: a golden INPUT, a golden OUTPUT, and an equality oracle that is not our own reimplementation.

They already exist, which is what makes this a task with real inputs rather than an aspiration:

- `docs/spikes/sqlite-in-the-browser/fixtures/stratagems-alpha1.stream.json.gz`: every log from the LAUNCHED stratagems deployment on Base (chain 8453): Stratagems `0x5ab6d5bb8012fc60ab3653e025be4a59b4406ff2`, Gems `0xb2d822732347e3dc60258dcf6cf0d4c7a432b678`, GemsGenerator `0xb0855eaf94bf7f122af4f444141e83b7408cc7a7`, blocks 12,082,307 to 23,400,000, captured 2026-08-22 at chain head 50,318,553. 31,332 events over 1,042 event-bearing blocks. Gzipped deliberately: 0.6 MB against 20.5 MB of JSON, and git stores both at about 0.6 MB, so the compressed form costs nothing in the repository and saves 20 MB in every working tree. `data` and `topics` are omitted, recorded in the fixture's own provenance as `omittedFields`.
- `fixtures/stratagems-alpha1.state.json`: the golden output, computed by the ORIGINAL stratagems `JSProcessor` (commit `3d5a0b3f`, 2024-12-18). A diff on it means the processor changed meaning.
- `src/port/` and `vendor/stratagems/`: the port to `MutationContext`, and the oracle copied verbatim.

`fixtures/stratagems-base.*` is the ABANDONED early deployment (45 logs), kept as the small fast smoke case, plain JSON because it is small enough to read. The folder name is a trap: `base/` is not "the Base deployment", it is one of two and the wrong one. Keep both, label them so nobody repeats the mistake.

The replay path already exists in production code: `@etherfold/core`'s stream fixture (`parseStreamFixture`, `replayStream`) was built during the spike and is what the browser harness used to fetch the fixture over HTTP and drive it. So this task is promotion and rewriting, not plumbing.

**The port should be rewritten onto the idiomatic model as part of promoting it, not copied as-is.** It was written before the prefix listing existed, so it carries the contortions the finding documents: three entities plus a hand-maintained CSV index for one ordered bounded array, and a hand-maintained count for an append. With `bounded-id-prefix-listing` landed, the ordered children can be keyed by something naturally unique (block plus log index, or an event ordinal) and derived when read, and both contortions disappear. The golden state is the check that the rewrite did not change meaning: it must still match byte-for-byte after canonicalisation. If it cannot be made to match, that is a finding, not a fixture update.

Two contortions will NOT disappear and should be documented rather than hidden: `uint256` has no column type (`text` / `integer` / `real` / `blob`, and SQLite's INTEGER is 64-bit, so every u256 is decimal TEXT read back through `BigInt()`, which makes equality depend on a canonical encoding that nothing in the model states or enforces), and a scalar map still needs its own entity (folding `owner` into `cell` is WRONG because `set` writes a WHOLE ROW and the processor writes an owner where it does not write a cell). The u256 encoding one is load-bearing here: 16,046 of the 31,332 real events write nothing but u256 fields.

Licence note, already settled and to be carried over: the vendored stratagems source is GPL-3.0 and this repository is MIT. Both are the same author's work and using it as an example and test fixture is fine; the note exists so the difference is visible to a reader who meets the code without this context.

Where the artifacts LIVE after promotion is a real decision: `docs/spikes/` is an evidence store, and a conformance fixture is production test material. Move or copy deliberately and leave the spike folder coherent either way.

## Acceptance criteria

- [ ] The conformance suite runs against the real captured stream and asserts the resulting state equals the golden state after canonicalisation, on every backend the suite covers.
- [ ] The small `stratagems-base` fixture is the fast smoke case and runs on every test invocation; the full `alpha1` run is available and runs in CI even if it is not in the default fast loop.
- [ ] The port is rewritten onto the idiomatic model (ordered children keyed by a naturally unique key, derived through the prefix listing, no CSV index, no hand-maintained count) and STILL produces the byte-identical golden state.
- [ ] The reorg case runs on the real stream: reverting to block 13,364,821 makes the evil owner's `computedPoints` DECREASE from 12 to 6. That is the canonical bug this design exists to prevent and it should be a named test, not a generic one.
- [ ] The fixture stays gzipped, and its provenance (contracts, block range, capture date, chain head, `omittedFields`) travels with it in a form a reader can find without this task.
- [ ] Both deployments are labelled so the `base/` versus `alpha1/` trap cannot be repeated: the abandoned one says so where a reader will see it.
- [ ] The GPL-3.0 versus MIT note travels with the vendored oracle.
- [ ] Where the artifacts live after promotion is decided and the spike folder is left coherent.
- [ ] Tests run in the repo's existing style, vitest, plus a changeset if any published package gained the fixture.

## Blocked by

- `state-store-conformance-suite`: this is its workload; without the suite there is nothing to promote into.
- `bounded-id-prefix-listing`: the port is rewritten onto it, and rewriting twice is the thing to avoid.

## Prompt

> Promote the `sqlite-in-the-browser` spike's captured stream, golden state and processor port into the conformance workload of the `etherfold` monorepo.
>
> FIRST, check this task against current reality: read `work/specs/proposed/one-processor-everywhere.md` (or `work/specs/tasked/`), `work/notes/findings/sqlite-in-the-browser.md` (particularly "The artifacts, and their provenance" and the contortion list), `work/tasks/done/spike-sqlite-in-the-browser.md`, and `docs/spikes/sqlite-in-the-browser/README.md`, which distinguishes what is REAL from what is GENERATED. Confirm `state-store-conformance-suite` and `bounded-id-prefix-listing` landed as assumed.
>
> The artifacts are committed and real. The input is 31,332 logs from the LAUNCHED stratagems deployment on Base over 1,042 event-bearing blocks; the output is the state the ORIGINAL `JSProcessor` computed from it, so the oracle is the code that has actually been running on Base and not a reimplementation. Do not regenerate either casually: a diff on the golden state means the processor changed meaning, which is a finding.
>
> The replay path exists in production code (`@etherfold/core`'s stream fixture: `parseStreamFixture`, `replayStream`, and the file form in `@etherfold/fs`), and the spike drove it from a browser over HTTP on all three engines. This is promotion, not plumbing.
>
> Rewrite the port onto the idiomatic model rather than copying it. It predates the prefix listing, so it carries a CSV index and a hand-maintained count that exist only because `MutationContext` could not list a set of rows and because a child id ended in a dense array position. Key ordered children by something naturally unique instead (block plus log index, or an event ordinal) and derive the collection when read. The golden state is your proof that the rewrite preserved meaning.
>
> Two contortions stay and should be documented, not hidden: u256 has no column type so every u256 is decimal TEXT read back through `BigInt()` (and 16,046 of the 31,332 events write nothing but u256 fields, so a non-canonical encoding is a real equality bug waiting to happen), and a scalar map needs its own entity because `set` writes a whole row.
>
> Watch the deployment trap: `contracts/deployments/base/` is the ABANDONED early deployment with 45 logs, not the launched game. The spike's task named it by mistake and the correction is the first section of the finding. Label both fixtures so nobody repeats it.
>
> Done means: the suite runs a real, launched processor's real event stream through every backend and compares against a state computed independently, including the revert-makes-a-counter-decrease case at block 13,364,821.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your final report, in particular where the promoted artifacts now live and what the fast versus full test split is.
