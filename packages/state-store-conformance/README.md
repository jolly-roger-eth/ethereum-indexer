# @etherfold/state-store-conformance

The suite a **state store** must pass to earn its place behind the seam. Adding a backend is providing a factory and running it:

```ts
import {describeStateStoreConformance} from '@etherfold/state-store-conformance';
import {MyStore} from '../src/index.js';

await describeStateStoreConformance('MyStore', (declarations) => new MyStore(declarations));
```

That is the whole integration. The suite creates a fresh store per case, calls `migrate` itself, and registers each case as its own vitest test, so a failure names the behaviour that broke.

## What it asserts

External behaviour only: what a read returns after a write, after a revert, as of a block. Never a table, never a statement, never a version column. A versioned-rows backend and a patch-log backend must both be able to pass the parts they claim, so a case that reaches for an internal is a defect in the case.

- **Versioned reads.** Write, overwrite, delete; a version is a COMPLETE row (a declared field a write leaves out becomes `NULL`) with a half-open validity range (live AT the block that opened it, not at the block that closed it); a deleted entity is absent from its delete block onward and fully readable as of any earlier block.
- **As-of reads, against what the store CLAIMS.** The suite reads the capability report and tests behaviour against it: `unbounded` answers at any depth, a WINDOW answers at its oldest retained block and refuses below it with a `BlockNotRetainedError` naming what was asked and what is kept, and a store that answers no historical read refuses every one of them. What none of them may do is serve a historical read from the tip.
- **Reorg revert, with a counter that must go back DOWN.** The load-bearing case. A stored counter that does not decrease when its block is reverted is the canonical bug this design exists to make impossible, and it is not hypothetical: `work/notes/findings/sqlite-in-the-browser.md` records the real instance, an accumulated `computedPoints` going from 12 back to 6. The counter is accumulated through the mutation context (read, add, write), because the read is where the bug bites.
- **Read-your-writes within a block.** Two events in one block that touch one counter compose; `update` carries a field it does not mention and `set` clears it.
- **A block is one atomic unit.** A block whose mutations include a rejected one applies none of them and does not take its height; applying one block twice raises.

Not here yet, and deliberately: the bounded id-prefix LISTING (`bounded-id-prefix-listing`) is the one read the model is still missing, so the read-your-writes group will gain its cases when that lands at the seam.

## Why the claim is read first

Testing a backend against a capability it never claimed fails honest backends. Testing it against LESS than it claimed is what lets a claim become fiction. So the suite reads `store.capabilities` once, from a probe store, and asks each backend exactly what it said it could do.

That the capability cases are real is itself a test: `test/the-suite-catches.test.ts` runs the suite against backends with one lie each (claiming a window it does not honour, answering an as-of read from the tip, accepting a revert without undoing it) and asserts which cases go red. Without that, the capability tests would be decoration.

## Running the cases directly

The cases are data, not registered tests, which is what makes the above possible: a suite that has already reported itself to a runner can be run but cannot be asserted on.

```ts
const {passed, failures} = await runStateStoreConformance(factory);
```

`stateStoreConformanceCases(factory)` gives the list itself, for driving it from another runner or from a browser harness. (The assertions are vitest's `expect`, which is why vitest is a peer dependency; the `describe`/`it` registration is the only part that needs a vitest RUN.)

## Backends that run it

- [`@etherfold/state-store`](../state-store)'s `MemoryStateStore`, under three retention claims (here, because that package cannot depend on this one).
- [`@etherfold/state-store-sqlite`](../state-store-sqlite)'s `VersionedStateStore`, on a real libSQL database, under the same three.

The workload is deliberately small and hand-written. The heavy subject, the captured stratagems stream and the port that reproduced its state byte-identically, is a second subject for this same suite (`promote-stratagems-conformance-workload`) and not a replacement: a case that fails on 31,332 real events is a bug report nobody can read.

## Tests

`pnpm --filter @etherfold/state-store-conformance test`, vitest.
