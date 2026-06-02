---
'ethereum-indexer-cli': patch
---

Rewrite `init()` to use the new shared processor/source-resolution helpers from `ethereum-indexer-utils` (`loadProcessorModule` + `instantiateProcessor` + `resolveSource`) instead of its own copy of that logic (LOW-4 in the server/CLI batch audit). Behaviour is preserved exactly: the CLI still constructs its own rate-limited `JSONRPCHTTPProvider`, owns its `keepState` wiring, calls the processor factory with no argument, and — importantly — keeps the original ordering (instantiate processor + `keepState` check happen before any `eth_chainId` RPC). As a side effect the CLI now also benefits from the `createRequire(...).resolve()` module-resolution fallback the server already had.

(The CLI uses the granular helpers rather than the bundled `resolveProcessorAndSource` precisely to preserve that ordering; the server uses the bundled helper since it has no equivalent intermediate check.)
