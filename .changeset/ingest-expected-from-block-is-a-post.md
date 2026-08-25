---
'@etherfold/server': minor
---

**Asking where the next batch starts is now `POST /ingest/expected-from-block`, not `GET /ingest`.**

Answering that question can WRITE: it reconciles a persisted cursor belonging to a different source, config or processor version by calling `processor.clear()`, exactly as `load()` does in the single-process shape. A `GET` that writes is a trap whatever its justification — proxies, browser prefetch, link scanners and retrying clients all assume a `GET` is safe, and HTTP says it is — so the method now matches what it does.

The token guard is registered on BOTH `/ingest` and `/ingest/*`: Hono matches `/ingest` exactly and would not have covered the new sub-path, which would have left half the fetcher-facing surface open while looking guarded. A test asserts a 401 on each.
