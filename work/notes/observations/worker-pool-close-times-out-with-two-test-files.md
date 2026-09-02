---
title: 'The Worker test pool takes a 10 s close timeout as soon as `platforms/cf-worker` has more than one test file'
slug: worker-pool-close-times-out-with-two-test-files
observed: 2026-09-02
source: 'noticed while building task:d1-limits-reach-the-stores-batch-bounds, adding `platforms/cf-worker/test/d1-limits.test.ts` beside the existing `status.test.ts`. Reproduced by running each file alone (clean exit, no message) and both together (the message, and ~10 s added to the run).'
---

`vitest run` in `platforms/cf-worker` now ends with `close timed out after 10000ms` / "Tests closed successfully but something prevents Vite server from exiting". Every test passes and the exit code is `0`, so it costs the gate about ten seconds rather than turning it red. It appears only when BOTH test files run in one invocation (`@cloudflare/vitest-pool-workers` 0.22 as a Vite plugin, vitest 4.1.8), which points at the pool's per-file workerd instances rather than at anything either test does.
