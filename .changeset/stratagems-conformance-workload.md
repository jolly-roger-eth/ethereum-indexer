---
'@etherfold/state-store-conformance': patch
---

Point at the heavy conformance workload, now that it exists.

The suite's own declarations stay small and hand-written, and the README and the `CONFORMANCE_ENTITIES` doc comment said the captured stratagems stream was a future task. It has landed as `@etherfold/conformance-workload-stratagems` (private, unpublished, because the vendored oracle it is derived from is GPL-3.0): 31,332 real logs from the LAUNCHED stratagems game on Base, replayed through the ported processor on every backend and compared against the state that game's ORIGINAL `JSProcessor` computed from the same bytes, including the revert that makes an accumulated `computedPoints` go back down from 12 to 6.

Documentation only. No behaviour, no exports and no types changed here.
