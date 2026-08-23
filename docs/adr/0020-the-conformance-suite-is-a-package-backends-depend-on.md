# The conformance suite is a package, and the cases inside it are data

The suite every `StateStore` backend must pass ships as **`@etherfold/state-store-conformance`**, a fourth package in the storage family, and its cases are a LIST OF VALUES that a thin adapter turns into vitest tests rather than `describe`/`it` calls made at import time. Both halves are decisions with real alternatives.

## Why a package and not a module of `@etherfold/state-store`

The obvious home is the seam itself, as a subpath export. It is refused for the reason ADR-0018 split the seam in the first place: `@etherfold/state-store` **declares no dependencies at all**, which is what makes it safe for a storage primitive to depend on, and `state-store-sqlite`'s leakage test asserts that emptiness precisely so the store cannot inherit anything. A conformance suite needs an assertion library, so putting it in the seam would either add a dependency to the package whose emptiness is load-bearing, or hide it behind an optional peer that npm's peer auto-install would drag in anyway.

The other candidate home is each backend's own `test/`, copied. That is the failure the suite exists to prevent, one folder up.

So it is a package: it depends on the seam, every backend depends on IT (as a devDependency), and no cycle exists because it knows nothing about any backend. `MemoryStateStore`'s own conformance run lives here rather than in `@etherfold/state-store` for exactly that reason, and that is the one visible cost of this shape.

The name reads off ADR-0014's role-first axis with the trailing slot filled by something that is not an engine, as ADR-0018 already established for `state-store` and `processor-entities`: `state-store-conformance` is the state-store role's conformance suite, and it sorts next to the role it belongs to in a scope listing. `conformance-state-store` would have broken that ordering and read as a backend called "conformance".

## Why the cases are data

A suite that registers vitest tests at import time can be RUN and cannot be ASSERTED ON. The task that landed this required a deliberately-lying backend to FAIL the suite, without which the capability cases are decoration, and there is no honest way to assert "these two cases went red" against a suite that has already reported itself to a runner. Nesting a second vitest process to read its output would make the proof slower than the suite and dependent on a reporter format.

So `stateStoreConformanceCases(factory)` returns `{group, name, run}` values, `runStateStoreConformance(factory)` executes them and reports which failed, and `describeStateStoreConformance(label, factory)` is a short adapter that registers each case as its own `it`. The lying-backend tests use the second; every backend uses the third; a harness that is not a vitest RUN (a browser page, a plain node script) uses either of the first two. Vitest stays a peer dependency either way, because the assertions are its `expect`: what the case list buys is independence from the RUNNER, not from the assertion library.

The cost is one indirection and a top-level `await` in each backend's test file: the case list depends on what the backend CLAIMS, and a claim can only be read from a store. Vitest collects a test file as an ES module, so this works, and the alternative (branching inside each case on the capabilities) would have produced case names that lie about what they assert.

## Consequences

- **A backend that claims something it cannot do goes red**, and that property is itself tested rather than asserted.
- **The suite tests a backend against its own claim**, so it can never fail an honest backend for a capability it never advertised. The other edge of that: a store claiming a window shorter than the suite's ladder is asked less, and the suite says so where it decides (`answersHistoryOverLadder`).
- **Shared cases have one home.** The SQLite tests that duplicated a shared case are gone from `state-store-sqlite`; what stays there is what only a versioned-row backend can be asked (the partial unique index, the batch, the revert ordering, the SQL query surface).
- **Every future backend** (`light-store-behind-the-seam`, `indexeddb-row-backend-browser-default`) adds a factory and a call, and the captured stratagems stream becomes a second SUBJECT for this same suite (`promote-stratagems-conformance-workload`) rather than a second suite.
