---
title: 'Spike: what SQLite in the browser actually costs, against a real workload'
slug: spike-sqlite-in-the-browser
spec: one-processor-everywhere
blockedBy: []
covers: [1, 2, 6, 7]
---

## What to build

A measurement, not a feature. `one-processor-everywhere` cannot pick a browser storage backend on judgement, because the disagreement is about numbers nobody here has. Produce them against a REAL workload, then write them up so the decision is made once and stays made.

The spike answers two questions, and the second one is the more dangerous to get wrong:

1. **What does each candidate backend cost** in payload, cold start, write throughput, read latency and footprint?
2. **Can the entity model actually express a real processor?** The spec commits to scalars plus id-reference relations, with aggregations and interfaces parked. If that cannot carry a processor someone really wrote, the spec is wrong and this is the cheapest possible moment to find out.

### The workload: stratagems on Base, replayed from a cached stream

Use `~/dev/github/wighawag/stratagems`. Its `indexer/` package is a real `JSProcessor` (13 handlers, ~160 lines) over deployed contracts on Base: `Stratagems` at `0xb99d938a722df8984722ab38732533130b4f3ec4` from block `11681933`, with `Gems` (`0xd1b76de5372bc47fc4b7ad918f11937fc17b7b46`, block `11681917`) and `GemsGenerator` (`0xbe2f7c303b53f16f447fd82bf549e65185bf3477`, block `11681921`) alongside.

**Capture the log stream once, then replay it offline for every measurement.** Querying the node per run makes the benchmark slow, rate-limited, non-deterministic and unfair between backends, because each candidate would see different bytes. A captured fixture makes every run identical by construction and removes the network from the measurement loop entirely.

Most of this exists and must not be rebuilt: `ExistingStream` in `@etherfold/core` is the seam (`fetchFrom` / `saveNewEvents` / `clear`), `keepStreamOnFile` in `@etherfold/fs` implements it on disk, and `@etherfold/browser` implements it on IndexedDB. What is missing is a **portable fixture a browser harness can load**, since the fs implementation is not available there, and a **replay mode that bypasses fetching** so a benchmark run does not touch a node at all. That gap is worth closing properly rather than with a throwaway, because a replayable stream fixture is wanted anyway: it is the basis of deterministic processor tests, of comparing two processor versions on identical input, and of the blue-green rebuild ADR-0008 describes.

**Why stratagems and not the GreetingsRegistry example.** Its state is deeply nested and awkward on purpose: keyed maps (`cells`, `owners`, `commitments`), an ordered array (`placements`), a singleton (`points.global`), per-account submaps (`points.fixed`, `points.shared`) and derived values (`computedPoints`). That is exactly the shape that will either validate the entity model or break it. A toy processor would validate nothing.

Port that processor to the spec's `MutationContext` API at **prototype quality**, and record every place the entity model made you contort the design. Those contortions are the finding, as much as the milliseconds are.

**Do not delete the artifacts afterwards.** The captured stream, the ported processor and the state it produces are the conformance workload the spec's shared suite needs: a golden input every backend replays, a golden output every backend must agree on, and an equality oracle that is not our own reimplementation, since the existing `JSProcessor` computed it independently. A later task promotes them once the seam exists; this task only has to produce them and record their provenance (the stratagems commit, the contracts, the block range, the date). Promoting them is NOT in this task's scope, and they stay prototype-quality here.

### Measure

Against the shape the system really uses, one block as one batch, because that is how blocks are applied. A loop of single-row inserts flatters every candidate and predicts nothing.

- **Payload**: gzipped and brotli, for `@sqlite.org/sqlite-wasm` and for `wa-sqlite`, counting what actually reaches a browser.
- **Cold start**: wasm compile plus database open, on a mid-range phone as well as a laptop. The laptop number alone is not decision-grade.
- **Write throughput**: sustained blocks per second replaying the captured stream.
- **Read latency**: point lookup by `(entity, id)` at the tip, and an as-of read at depth.
- **Storage footprint** as a function of retention window, which is the knob the spec introduces.
- **Backwards replay cost** for the patch-based light path: what it costs to answer an as-of read by replaying immer reverse patches across a finality-depth window. This settles the spec's second open question.
- **Behaviour under pressure**: quota limits, and what `navigator.storage.persist()` changes.

Across `opfs-sahpool` and `IDBBatchAtomicVFS`, on Chrome, Firefox and Safari. Safari is likeliest to embarrass the plan, so do not leave it until last.

**Baseline against the incumbent**, today's whole-state JSON blob written to IndexedDB on every save, which is O(total state) per write. This is a comparison and a comparison needs both sides. Running the real stratagems state through it is also the only way to see how badly it degrades as state grows, which is the thing being fixed.

### What is already established, so you do not re-derive it

- IndexedDB backing comes from **wa-sqlite**'s `IDBBatchAtomicVFS`; the official `@sqlite.org/sqlite-wasm` build ships OPFS VFSes plus a small `kvvfs`.
- The plain `opfs` VFS **requires COOP/COEP headers**; **`opfs-sahpool` does not**, and works on all major browsers released since March 2023.
- OPFS is origin-private and raises **no permission prompt**. The prompting API is File System Access (`showDirectoryPicker`), a different thing. `navigator.storage.persist()` is the only prompt-adjacent call and applies to IndexedDB equally.

## Acceptance criteria

- [ ] A captured stratagems-on-Base log stream exists as a fixture that both a node and a browser harness can replay, with how it was captured written down (block range, contracts, date).
- [ ] Every measurement replays that fixture. No benchmark run queries a node.
- [ ] `docs/spikes/sqlite-in-the-browser/` holds a re-runnable harness plus raw output, with a README saying how to run it.
- [ ] `work/notes/findings/sqlite-in-the-browser.md` carries a `source:` naming the script, commit, browsers and versions, device class, and date.
- [ ] Payload, cold start, write throughput, read latency, footprint-by-retention and quota behaviour are reported for `opfs-sahpool` and `IDBBatchAtomicVFS` on Chrome, Firefox and Safari.
- [ ] The whole-blob incumbent is measured on the same fixture and reported alongside.
- [ ] Backwards-replay cost for the patch-based light path is measured across a finality-depth window.
- [ ] The stratagems processor is ported to the `MutationContext` API, runs to completion over the fixture, and produces state equal to what the existing `JSProcessor` produces on the same input. Equality against the incumbent is what makes the port trustworthy as a benchmark subject.
- [ ] Every place the entity model forced a contortion is written up in the finding, naming what was awkward and what would have been natural. Report even if nothing was awkward: that is a result too.
- [ ] The finding states a recommendation with its conditions, as "default to X; choose Y when Z", and names what would overturn it.
- [ ] The finding answers all open questions in `one-processor-everywhere` explicitly enough that its flags can be cleared.
- [ ] The fixture, the ported processor and the golden state are retained with provenance (stratagems commit, contracts, block range, date), so a later task can promote them into the conformance workload without recapturing anything.
- [ ] No production code changes beyond the stream-fixture capture/replay path, which is deliberately allowed to be real. The ported processor stays prototype-quality in the spike folder; promoting it is a later task.

## Blocked by

- None. It measures candidates and needs neither the seam nor the server to exist.

## Prompt

> Measure what SQLite in the browser costs, against a real workload, so that `work/specs/proposed/one-processor-everywhere.md` can choose a browser storage backend on evidence rather than on taste.
>
> FIRST read that spec, especially its open questions, since your output is what clears them. Then read `work/protocol/WORK-CONTRACT.md` on spikes and findings: evidence goes in `docs/spikes/<slug>/`, knowledge goes in `work/notes/findings/<slug>.md` with a `source:` naming the script, its commit, what it ran against and when. A load-bearing measurement MUST become a finding, because a spike folder alone leaves the reason undiscoverable and the next person re-litigates the decision.
>
> The workload is the real stratagems processor over its real Base logs, replayed from a captured stream fixture. The task body has the addresses, the blocks, and what already exists so you do not rebuild it (the `ExistingStream` seam, `keepStreamOnFile`, the browser IndexedDB stream store). Capture once, replay for every measurement: a node in the measurement loop makes the benchmark slow, rate-limited and unfair between candidates, because each would see different bytes.
>
> You are answering two questions and the second matters more. The numbers are one. The other is whether the spec's entity model (scalars plus id-reference relations, aggregations parked) can express a processor someone really wrote, whose state is nested maps, an ordered array, a singleton and derived values. Port it, run it, and check the ported version produces state equal to the existing JSProcessor's on identical input. Write down every contortion the entity model forced. If it forced none, say so plainly, because that is the result that unblocks the spec fastest.
>
> Three things that would otherwise make this worthless: measure one block as one batch rather than a loop of inserts; measure on a mid-range phone, because the laptop number will make everything look fine; and measure the incumbent whole-state JSON blob on the same fixture, since without it there is no comparison.
>
> Report a recommendation WITH conditions and with what would overturn it. If the candidates are close enough that it does not matter, say so: that is a legitimate result meaning the seam absorbs the difference.
>
> The ported processor stays prototype-quality in the spike folder, but do NOT throw the artifacts away: the fixture, the port and the state it produces become the conformance workload later, so record their provenance (stratagems commit, contracts, block range, date). Promoting them is a later task, not yours. The capture/replay path may be real code, because a replayable stream fixture is wanted anyway. Do no git operations.

---

### Claiming this task

```sh
dorfl claim spike-sqlite-in-the-browser --arbiter <remote>
git fetch <remote> && git switch -c work/spike-sqlite-in-the-browser <remote>/main
git mv work/tasks/ready/spike-sqlite-in-the-browser.md work/tasks/done/spike-sqlite-in-the-browser.md
```
