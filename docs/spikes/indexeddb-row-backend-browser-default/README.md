# indexeddb-row-backend-browser-default — the browser evidence

What `@etherfold/state-store-indexeddb` did in real browsers, kept so that ADR-0024 points at an OBSERVATION rather than at a claim.

This is not a spike and nothing here was re-measured: the numbers that decided IndexedDB over wasm SQLite are `work/notes/findings/sqlite-in-the-browser.md`, with raw output in `../sqlite-in-the-browser/results/`. What is kept here is the output of the shipped backend's own browser run.

## How it is produced

```bash
pnpm --filter @etherfold/state-store-indexeddb test:browser              # all three engines
pnpm --filter @etherfold/state-store-indexeddb test:browser --project=webkit
```

The specs are `packages/state-store-indexeddb/browser/`, on `playwright-browser-harness`: the store and the shared conformance suite are bundled into a real page, driven, and their structured results come back to node.

## What is in `results/`

| file | what it holds |
| --- | --- |
| `browser-<engine>.json` | one entry per case: the conformance run (per retention claim), the same-processor comparison, the listing's `IDBKeyRange` as the engine itself reported it, and persistence across a real reload. `env` records the user agent the run happened on |
| `multi-tab-<engine>.json` | four tabs against one database: what each tab wrote, what it read back, and the audit from a fifth connection |
| `playwright.json` | the run itself, from Playwright's own reporter |

The four cases, and why each is here rather than in the node suite:

- **conformance** — the SHARED suite (`@etherfold/state-store-conformance`), the same cases the SQL store and the patch store are held to, under all three retention claims this backend can make. The node run uses `fake-indexeddb`, which is the API without an engine; this is the engine.
- **processor** — the same `EntityProcessor` object, run in node against `MemoryStateStore` and in the tab against IndexedDB, compared row for row INCLUDING the version bounds, and through a reorg whose accumulated counter has to go back down (5 → 4 → 5).
- **access-path** — the listing's key range, read off the engine's own `IDBObjectStore.openCursor`: `bound(['placement','7'], ['placement','7',[]])`, four records walked out of 200 rows.
- **persistence** — write, RELOAD the page, read. A reload is the only honest cold start, and it is the thing no node test can show.

## Reading the results

`browser-<engine>.json` is one run's `runs[]`; a case is a failure only if `errors` is non-empty or `results.failures` is. The `timings` are `performance.now()` samples from inside the page and are NOT a benchmark: the workloads here are small on purpose (they exist to be correct, not to be fast), and the ms/block numbers that carry weight are the finding's.
