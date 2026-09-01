---
'@etherfold/state-store-sqlite': minor
---

**`DEFAULT_BATCH_BOUNDS` is now set by the tightest hosted backend's FREE tier, so an unconfigured deployment works everywhere.** `maxRowsPerStatement` drops from 500 to **100** and `maxStatementsPerBatch` from 100 to **50**; `maxBytesPerBatch` is unchanged at 90,000.

The `maxRowsPerStatement` change is a BUG FIX, not a tuning change. `prune` deletes by an explicit list of row ids and each id is a bound parameter, so the old default of 500 emitted a query with 500 bound parameters against a hosted backend that caps them at 100 per query. Retention enforcement therefore failed there while passing on every other backend and in every test: the shape that runs locally and fails only in production. The previous docstring claimed the default was "small enough to fit inside the tightest hosted limits we are aware of", which was not true.

Both remain CONFIGURATION: pass `{bounds}` to raise them on a local file database or a paid tier, where they are an ordinary throughput knob. `maxRowsPerStatement` is the exception and should not be raised without checking the target backend's per-query parameter limit.

The vendor's specific limits, their dated source and the plan split are recorded in `work/notes/findings/` rather than in this package, which names no hosted backend by assertion (`test/no-platform-leakage.test.ts`).
