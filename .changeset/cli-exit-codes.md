---
'ethereum-indexer-cli': patch
---

The `ei` CLI now resolves a proper process exit code: `0` on success and `1` on failure. Previously `cli.ts` did `run().then(() => console.log('DONE'))` with no `.catch` and no `process.exit`, so a failed index (bad node URL, RPC error, processor throw, write failure) could look like a successful CI step — and on success the process could linger because the provider's rate-limit timers kept the event loop alive. The success/failure-to-exit-code logic is encapsulated in an exported `main(options, deps?)` (with injectable `run`/`exit`/`log`/`error` for testing); `cli.ts` calls it with the real `process.exit`. On failure the error is reported and `DONE` is not printed.
