# The worker's "same status shape" test cannot fail

2026-09-03, spotted while adding the `/status` cursor field. `platforms/cf-worker/test/status.test.ts`'s second case compares `Object.keys(body).sort()` against a hard-coded key list that is itself `.filter((k) => k in body)`, so the expectation is derived from the body it is checking: any key the worker stops reporting, and any key it starts reporting, still passes. Left alone (out of this task's scope); the new case beside it asserts the one key that mattered here.
