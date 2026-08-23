---
title: 'Spike: does wasm SQLite ever beat the IndexedDB backend for OUR workload?'
slug: spike-sqlite-in-the-browser
spec: one-processor-everywhere
blockedBy: []
covers: [1, 2, 6, 7]
---

## What to build

A measurement, not a feature, and a NARROWER one than it first appears: most of this question was already answered in `~/dev/github/wighawag/research/`, and this task exists to verify the standing recommendation against a workload that is ours and real, not to re-open it.

### Read the prior work first. It is substantial and it already decided things.

- **`research/browser-embedded-indexer/README.md`** asked exactly the architectural question this spec asks (should the storage seam sit at the raw `remote-sql` level, forcing wasm SQLite into the browser, or higher up so the browser can use a non-SQL store?) and **answered it on sourced evidence: put the seam higher, and run the browser on IndexedDB or in-memory rather than shipping ~1 MB of wasm.** That is the same seam placement `one-processor-everywhere` specifies, arrived at independently, which is corroboration rather than coincidence.
- **`research/browser-embedded-indexer/tasks/in-browser-sqlite-spike.md`** is the open task this one continues. Its framing is the one to adopt: the IndexedDB backend is the **proven, measured default** (real-browser-verified on Chromium, Firefox and WebKit; storage adds roughly 3.3 KB gzipped; sub-millisecond to low-millisecond open), and what is missing is the **head-to-head crossover**: for our query shapes, does wasm SQLite ever win, at what dataset size, and is it worth the payload and the operational surface?
- **`research/playwright-browser-test-harness/`**, published as the npm package **`playwright-browser-harness`**, already provides the COOP/COEP server, esbuild Worker bundling and a wasm-SQLite-OPFS fixture pattern, built and verified on Debian 13. **Do not rebuild harness plumbing.** It also covers WebKit, which is how this gets Safari-engine evidence from a Linux machine.
- **`research/graphql-frontend-for-indexer-state/`** holds the query-layer decision (Yoga plus Pothos over the same model) and designed `LogFetcher` and `FeedCore` to be platform-agnostic for exactly this reuse.

Already sourced, so do not spend the spike re-deriving it: wasm SQLite costs roughly **839 KB of wasm plus 560 KB of JS**, is **Worker-only**, needs either COOP/COEP or the single-connection `opfs-sahpool` VFS, opens asynchronously, and hits `SQLITE_BUSY` in multi-tab scenarios. Separately: `opfs-sahpool` needs no COOP/COEP and works on all major browsers since March 2023, IndexedDB backing for SQLite comes from wa-sqlite's `IDBBatchAtomicVFS`, and OPFS raises no permission prompt (the prompting API is File System Access, which is a different thing).

### What is actually missing: our workload

The prior evidence reasons about "small live set, current-state reads, block-paced writes". That is an assumption about our workload, and it has never been run against a real one.

Use `~/dev/github/wighawag/stratagems`. Its `indexer/` package is a real `JSProcessor` (13 handlers, ~160 lines) over contracts deployed on Base: `Stratagems` at `0xb99d938a722df8984722ab38732533130b4f3ec4` from block `11681933`, with `Gems` (`0xd1b76de5372bc47fc4b7ad918f11937fc17b7b46`, block `11681917`) and `GemsGenerator` (`0xbe2f7c303b53f16f447fd82bf549e65185bf3477`, block `11681921`).

**Capture its log stream once, then replay it offline for every measurement.** Querying the node per run makes the benchmark slow, rate-limited, non-deterministic and unfair between candidates, since each would see different bytes. Most of this exists: `ExistingStream` in `@etherfold/core` is the seam, `keepStreamOnFile` in `@etherfold/fs` implements it on disk, and `@etherfold/browser` implements it over IndexedDB. What is missing is a fixture a **browser** harness can load (the fs implementation is not available there) and a replay mode that bypasses fetching. Build that part properly: deterministic replay is wanted anyway, for reproducible processor tests, for comparing two processor versions on identical input, and for ADR-0008's blue-green rebuild.

**Why stratagems and not the GreetingsRegistry example.** Its state is deliberately awkward: keyed maps (`cells`, `owners`, `commitments`), an ordered array (`placements`), a singleton (`points.global`), per-account submaps and derived values (`computedPoints`). It is the shape that will either validate the entity model or break it. A toy processor validates nothing.

### The two questions

1. **Where is the crossover, if there is one?** With the real stratagems stream replayed at several dataset sizes, does wasm SQLite ever beat the IndexedDB backend behind the same seam, and at what size? The presumption going in is that it does not, and the honest outcome is very likely "IndexedDB stays the default", so the valuable result is the CONDITION under which that flips, stated precisely.
2. **Can the entity model express a processor someone really wrote?** Port the stratagems processor to the spec's `MutationContext` API at prototype quality, and check it produces state equal to the existing `JSProcessor` on identical input. Record every place the model forced a contortion. This settles the spec's third open question and is the more dangerous one to get wrong, since everything else is built on it.

Do not delete the artifacts. The captured stream, the port and the state it yields become the conformance workload (a golden input, a golden output, and an equality oracle computed independently by the existing processor). Record their provenance: stratagems commit, contracts, block range, date. Promoting them is a later task.

### Measure

One block as one batch, because that is how blocks are applied; a loop of single-row inserts flatters everything and predicts nothing. Sustained write throughput over the replayed stream; point lookup by `(entity, id)` at the tip; an as-of read at depth; footprint as a function of retention window; and the backwards-replay cost of answering an as-of read from immer reverse patches across a finality-depth window, which settles the spec's second open question. Cold start on a mid-range device profile, not only a laptop. Multi-tab behaviour, since `SQLITE_BUSY` is a known failure mode and a browser indexer will meet it.

**Baseline against the incumbent**, today's whole-state JSON blob written to IndexedDB on every save, which is O(total state) per write. Running real stratagems state through it is the only way to see how it degrades as state grows, which is the thing being fixed regardless of which backend wins.

## Acceptance criteria

- [ ] The prior research is read and its standing recommendation is either confirmed or overturned explicitly, with the numbers that decided it.
- [ ] `playwright-browser-harness` is used for real-browser measurement; no harness plumbing is rebuilt.
- [ ] A captured stratagems-on-Base stream exists as a fixture both a node and a browser harness can replay, with provenance recorded.
- [ ] Every measurement replays that fixture; no benchmark run queries a node.
- [ ] Write throughput, read latency, as-of cost, footprint-by-retention, cold start and multi-tab behaviour are reported for the IndexedDB backend and for wasm SQLite, on Chromium, Firefox and WebKit.
- [ ] The whole-blob incumbent is measured on the same fixture and reported alongside.
- [ ] Backwards-replay cost for the patch-based light path is measured across a finality-depth window.
- [ ] The stratagems processor is ported to `MutationContext`, runs to completion over the fixture, and produces state equal to the existing `JSProcessor` on the same input.
- [ ] Every contortion the entity model forced is written up, or its absence stated plainly.
- [ ] `docs/spikes/sqlite-in-the-browser/` holds the re-runnable harness and raw output; `work/notes/findings/sqlite-in-the-browser.md` carries a `source:` naming script, commit, browsers and versions, device profile and date.
- [ ] The finding states the crossover as a condition ("IndexedDB unless Z"), and names what would overturn it.
- [ ] All three open questions in `one-processor-everywhere` are answered explicitly enough to clear its flags.
- [ ] No production code changes beyond the stream capture/replay path. The port stays prototype-quality; promoting it is a later task.

## Blocked by

- None.

## Prompt

> Verify, against a real workload, whether wasm SQLite ever beats the IndexedDB backend in the browser, so that `work/specs/proposed/one-processor-everywhere.md` can clear its open questions.
>
> READ THE PRIOR WORK FIRST; this question is largely already answered and your job is to verify it against our workload, not to re-open it. `~/dev/github/wighawag/research/browser-embedded-indexer/README.md` decided the seam placement on sourced evidence (seam above raw SQL, browser on IndexedDB, do not ship ~1 MB of wasm); its `tasks/in-browser-sqlite-spike.md` is the open head-to-head this task continues; `playwright-browser-harness` on npm is the real-browser harness and already handles COOP/COEP, Worker bundling and the wasm-SQLite-OPFS fixture, so do not rebuild it. The task body lists the payload and multi-tab facts already sourced. Spend the spike on numbers, not on rediscovery.
>
> The missing piece is our workload: the real stratagems processor over its real Base logs, captured once into a stream fixture and replayed offline for every run. A node in the measurement loop makes the benchmark slow, rate-limited and unfair between candidates. The task body has addresses, blocks, and what already exists so you do not rebuild the stream seam.
>
> You are answering two questions and the second matters more. The crossover is one, and the likely honest answer is "IndexedDB stays the default", so the valuable output is the precise condition under which that flips. The other is whether the spec's entity model (scalars plus id-reference relations, aggregations parked) can express a processor someone really wrote, whose state is nested maps, an ordered array, a singleton and derived values. Port it, run it, and verify the port yields state equal to the existing JSProcessor's on identical input. Write down every contortion; if there were none, say so plainly, because that is what unblocks the spec fastest.
>
> Measure one block as one batch, on a mid-range device profile as well as a laptop, and measure the incumbent whole-state JSON blob on the same fixture, since without it there is no comparison. Include multi-tab, because `SQLITE_BUSY` is a known failure mode and a browser indexer will meet it.
>
> Evidence goes to `docs/spikes/<slug>/`, knowledge to `work/notes/findings/<slug>.md` with a `source:` naming script, commit, browsers, device profile and date; `work/protocol/WORK-CONTRACT.md` requires the finding because a capability is withheld or enabled by this result. Report the recommendation as a condition and name what would overturn it. Keep the artifacts (fixture, port, golden state) with their provenance: they become the conformance workload later. Change no production code beyond the capture/replay path. Do no git operations.

---

### Claiming this task

```sh
dorfl claim spike-sqlite-in-the-browser --arbiter <remote>
git fetch <remote> && git switch -c work/spike-sqlite-in-the-browser <remote>/main
git mv work/tasks/ready/spike-sqlite-in-the-browser.md work/tasks/done/spike-sqlite-in-the-browser.md
```

---

## Decisions

Transcribed verbatim from the builder's final report, per `WORK-CONTRACT.md`: a builder's rationale for non-obvious in-scope choices has exactly one channel, and this is it.

- **The task's premise was wrong, and the work was redirected rather than bounced.** The addresses in the body (`deployments/base`, Stratagems `0xb99d938a722df8984722ab38732533130b4f3ec4` from 11,681,933) are an early, abandoned deployment that saw 45 logs across 10 blocks. The LAUNCHED game is `contracts/deployments/alpha1`, which is also Base (its `.chain` file says `chainId: 8453`, same genesis hash), at Stratagems `0x5ab6d5bb8012fc60ab3653e025be4a59b4406ff2` from 13,499,257, with 26,308 logs. Everything is measured on `alpha1`; `base` is kept as a small smoke fixture. The task body is deliberately NOT edited, because it is a launch snapshot and rewriting it would falsify the record of what was asked.
- **The crossover sweep is generated, and says so everywhere.** The real capture drives the port equality, the shape facts, the sparsity result and the head-to-head at the real size, but the game never reached the dataset sizes where a crossover occurs. The generated workloads use real event shapes, real handlers and real mutations out of the real processor, with invented play. Orders of magnitude are sound; the exact write mix inherits an assumption about how people play.
- **The SQLite worker hosts the store, not a SQL socket.** Page-per-statement messaging would have cost a round-trip per statement and made SQLite look absurd for reasons unrelated to SQLite. The block-level boundary is what a real deployment would do. The price of the choice (a `postMessage` round-trip on every point read, which no tuning removes because the OPFS sync VFS is Worker-only) is reported rather than hidden.
- **The committed fixture is gzipped, and the derived trace is not committed.** 0.6 MB against 20.5 MB of JSON, with git storing both at about 0.6 MB, so the compressed form costs nothing in the repository and saves 20 MB in every working tree. `data` and `topics` are omitted as the encoded form of the already-decoded `args` (recorded in the fixture's own `provenance.omittedFields`). The 12 MB `*.trace.json` is gitignored because `run/verify-port.ts` regenerates it identically in about three seconds; the 618 KB golden `*.state.json` IS committed, because it is the oracle and a diff on it means the processor changed meaning. A re-capture was verified byte-identical apart from `capturedAt` and `chainHeadAtCapture`.
- **A production defect was found and deliberately NOT fixed.** An entity column named `index` passes `@etherfold/state-store-sqlite`'s identifier validation and then fails at `migrate()` with `near "index": syntax error`, while the in-memory and IndexedDB backends accept it. Fixing it was outside "no production code beyond the capture/replay path", so it is captured with its mechanism and two fix shapes in `work/notes/observations/entity-identifier-sql-keyword.md`; the port renamed its column to `playerIndex`.
- **`vendor/stratagems/` is GPL-3.0 inside an MIT repository.** Same author, deliberate, and fine for an example and a test fixture. Noted in that folder's README so a reader who meets the files without this context can see the difference rather than wonder whether it was an accident.
- **`@etherfold/fs` gained a test script**, which it did not have, because the new file helpers needed one.

## Outcome

`work/notes/findings/sqlite-in-the-browser.md` carries the result and answers all three open questions in `work/specs/proposed/one-processor-everywhere.md`. Headline: IndexedDB stays the browser default; on the real workload it beats wasm SQLite by 1.6x to 6.9x on writes and 4x to 14x on reads, and the crossover (Chromium only, roughly 5,000 to 13,000 live rows) sits above the 4,072 live rows the real deployment reached. The port produces state equal to the original `JSProcessor` on the real stream, with every contortion the entity model forced written up.

Spawned: `work/notes/observations/entity-identifier-sql-keyword.md`, `work/notes/ideas/opfs-backed-browser-store.md`.
