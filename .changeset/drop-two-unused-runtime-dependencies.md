---
'@etherfold/processor-sqlite': patch
---

Dropped `named-logs` from the runtime dependencies: nothing in the package imports it, so it was an install a consumer paid for and never used.
