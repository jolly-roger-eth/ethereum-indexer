---
'ethereum-indexer': minor
'ethereum-indexer-browser': minor
'ethereum-indexer-cli': minor
'ethereum-indexer-db-processors': minor
'ethereum-indexer-db-utils': minor
'ethereum-indexer-fs': minor
'ethereum-indexer-fs-cache': minor
'ethereum-indexer-js-processor': minor
'ethereum-indexer-server': minor
'ethereum-indexer-utils': minor
---

Switch the build from `tsup` to `tsc` and ship ESM-only output. The CommonJS build (`dist/*.cjs`) and the `main` field have been removed; packages are now consumed via the `module`/`exports` ESM entrypoints only. Module resolution moves to `NodeNext` (relative imports now carry explicit `.js` extensions, JSON imports use import attributes).
