---
'@etherfold/core': minor
'@etherfold/browser': minor
'etherfold': minor
'@etherfold/fs': minor
'@etherfold/fs-cache': minor
'@etherfold/js-processor': minor
'@etherfold/utils': minor
---

Switch the build from `tsup` to `tsc` and ship ESM-only output. The CommonJS build (`dist/*.cjs`) and the `main` field have been removed; packages are now consumed via the `module`/`exports` ESM entrypoints only. Module resolution moves to `NodeNext` (relative imports now carry explicit `.js` extensions, JSON imports use import attributes).
