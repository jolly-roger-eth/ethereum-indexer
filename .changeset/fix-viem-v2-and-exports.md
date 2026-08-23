---
'@etherfold/core': minor
'@etherfold/browser': minor
'etherfold': minor
'@etherfold/fs': minor
'@etherfold/fs-cache': minor
'@etherfold/js-processor': minor
'@etherfold/utils': minor
---

Update all dependencies to their latest versions and fix the resulting build.

Dependency updates (notable):

- `viem` 1.x → `^2.52.0` (major), `abitype` → `^1.2.4`
- `pouchdb` / `pouchdb-find` → `^9.0.0`, `commander` → `^15.0.0`, `koa` → `^3.2.1`
- `typescript` → `^6.0.3`, `vitest` → `^4.1.8`, plus various `@types/*`, `eip-1193`, `named-logs`, `fs-extra`, etc.

Fixes required by the updates:

- `@etherfold/core`: handle viem v2's stricter `encodeEventTopics` return type (`(Hex | Hex[] | null)[]`) and the generic `eventName` returned by `decodeEventLog` over `AbiEvent[]`.
- `@etherfold/browser`: align `LastSync`/`ExistingStream` generic vs. base `Abi` usage that broke under viem v2's tighter `DecodeEventLogReturnType`.
- `@etherfold/fs-cache`: spread typed event args safely; make the package explicitly ESM (`type: module`) with `.js` import extensions.
- All published packages: add a standard `exports` map (ESM-only, no `main`) so modern bundlers/test runners (Vite/Vitest v4) resolve the package entry correctly.

JS processor authoring keeps full ABI-derived type safety (`event.args` typed from the ABI).
