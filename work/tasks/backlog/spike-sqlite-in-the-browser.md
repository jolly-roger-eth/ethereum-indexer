---
title: Spike: what SQLite in the browser actually costs
slug: spike-sqlite-in-the-browser
spec: one-processor-everywhere
blockedBy: []
covers: [6, 7]
---

## What to build

A measurement, not a feature. `one-processor-everywhere` cannot pick a recommended browser backend on judgement, because the disagreement is entirely about numbers nobody here has: payload, cold start, write throughput, and whether Safari behaves. Produce those numbers, then write them up so the decision is made once and stays made.

**Deliverables, and their homes are fixed by the work contract.** The evidence (probe scripts, harness, raw output) lands in `docs/spikes/sqlite-in-the-browser/`. The knowledge lands in `work/notes/findings/sqlite-in-the-browser.md` with a `source:` line naming the script, its commit, what it ran against (browser and version, device class) and when. This is load-bearing by definition, since a capability is withheld or enabled because of it, so the finding is required rather than optional. Do NOT leave the conclusion only in a spike folder: nobody greps `docs/spikes/` when asking why a default was chosen.

### What is already established, so you do not re-derive it

- The official `@sqlite.org/sqlite-wasm` build ships OPFS-based VFSes plus a small `kvvfs`. IndexedDB as a backing store comes from **wa-sqlite**'s `IDBBatchAtomicVFS`.
- There are two OPFS flavours and the difference decides deployability: the plain `opfs` VFS **requires COOP/COEP headers** (cross-origin isolation, for SharedArrayBuffer and `Atomics.wait`), while **`opfs-sahpool` does not** and works on all major browsers released since March 2023.
- OPFS is origin-private and raises **no permission prompt**. The prompting API is File System Access (`showDirectoryPicker`), which is a different thing. `navigator.storage.persist()` is the only prompt-adjacent call and it applies to IndexedDB equally.

So the open questions are cost and behaviour, not feasibility or permissions.

### Measure

Against a realistic shape, meaning one block is one batch of entity writes, because that is exactly how the store applies blocks. A synthetic loop of single-row inserts will flatter every candidate and predict nothing.

- **Payload**: gzipped and brotli, for `@sqlite.org/sqlite-wasm` and for `wa-sqlite`, counting what actually ships to a browser.
- **Cold start**: wasm compile plus database open, on a mid-range phone as well as a development laptop. The laptop number alone is not decision-grade.
- **Write throughput**: blocks per second at a few entity-writes-per-block ratios, sustained rather than peak.
- **Read latency**: point lookup by `(entity, id)` at the tip, and an as-of read at depth.
- **Storage footprint** as a function of retention window, which is the knob the spec introduces.
- **Backwards replay cost** for the light path: how expensive is answering an as-of read by replaying immer reverse patches across a finality-depth window. This decides open question 2 in the spec, so it is not optional.
- **Behaviour under pressure**: what happens at quota limits, and what `navigator.storage.persist()` changes.

Across `opfs-sahpool` and `IDBBatchAtomicVFS`, on Chrome, Firefox and Safari. Safari is the one most likely to embarrass the plan, so do not leave it until last.

**Baseline against the incumbent.** Today's browser persistence serialises the whole state blob to IndexedDB on every save, which is O(total state) per write. Measure that too. If a candidate loses to it on payload but wins by an order of magnitude on writes, that is the actual trade being decided, and a comparison that omits the incumbent cannot show it.

## Acceptance criteria

- [ ] `docs/spikes/sqlite-in-the-browser/` holds a re-runnable harness and its raw output, with a README saying how to run it.
- [ ] `work/notes/findings/sqlite-in-the-browser.md` exists and carries a `source:` naming the script, commit, browsers and versions, device class, and date.
- [ ] Payload, cold start, write throughput, read latency, footprint-by-retention and quota behaviour are reported for `opfs-sahpool` and `IDBBatchAtomicVFS`, on Chrome, Firefox and Safari.
- [ ] The whole-blob incumbent is measured on the same harness and reported alongside.
- [ ] Backwards-replay cost for the patch-based light path is measured across a finality-depth window.
- [ ] The finding states a RECOMMENDATION with its conditions, in the form "default to X; choose Y when Z", and names what would overturn it.
- [ ] The finding answers both open questions in `one-processor-everywhere` explicitly enough that the spec's flags can be cleared.
- [ ] No production code changes. This task ships evidence and knowledge, nothing else.

## Blocked by

- None. Deliberately independent: it measures candidates, it does not need the seam to exist.

## Prompt

> Measure what SQLite in the browser costs, so that `work/specs/proposed/one-processor-everywhere.md` can pick a browser storage backend on evidence.
>
> FIRST read that spec, particularly its two open questions, since your output is what clears them. Then read `work/protocol/WORK-CONTRACT.md` on spikes and findings: evidence goes in `docs/spikes/<slug>/`, knowledge goes in `work/notes/findings/<slug>.md` with a `source:` that names the script, its commit, what it ran against and when. A measurement that is load-bearing MUST become a finding; a spike folder alone leaves the reason undiscoverable and the next person re-litigates it.
>
> The task body lists what to measure and what is already established about VFS choices, COOP/COEP and permissions. Do not spend the spike re-establishing those; spend it on numbers.
>
> Three things that will otherwise make this spike worthless. Measure the shape the system actually uses, one block as one batch, not a loop of single inserts. Measure on a mid-range phone, because the laptop number will make everything look fine. And measure the incumbent, today's whole-state JSON blob written to IndexedDB on every save, because the decision is a comparison and a comparison needs both sides.
>
> Report a recommendation WITH its conditions and with what would overturn it, in the form "default to X; choose Y when Z". A finding that says "it depends" without saying on what is not a finding. If the numbers are close enough that the choice does not matter, say that plainly: it is a legitimate and useful result, and it means the seam absorbs the difference.
>
> Change no production code. Do no git operations.

---

### Claiming this task

```sh
dorfl claim spike-sqlite-in-the-browser --arbiter <remote>
git fetch <remote> && git switch -c work/spike-sqlite-in-the-browser <remote>/main
git mv work/tasks/ready/spike-sqlite-in-the-browser.md work/tasks/done/spike-sqlite-in-the-browser.md
```
