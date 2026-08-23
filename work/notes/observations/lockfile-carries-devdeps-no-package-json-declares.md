---
title: 'The committed `pnpm-lock.yaml` carried two devDeps no `package.json` declares'
slug: lockfile-carries-devdeps-no-package-json-declares
observed: 2026-08-23
source: 'task:query-surface-from-entity-declarations, after running `pnpm install` on a fresh clone'
---

At `d45f11d` the lockfile's `packages/processor-entities` importer listed `@etherfold/state-store-indexeddb` and `fake-indexeddb`, which that package's `package.json` does not declare, so a plain `pnpm install` rewrites the lockfile on a clean tree (this task's commit carries that removal as an incidental diff). A `pnpm install --frozen-lockfile` on main would fail for the same reason.

Not investigated further. Recorded because it means the lockfile and the manifests disagreed on main, and because whichever change added those devDeps to try IndexedDB in `processor-entities` tests appears to have been reverted in the manifest only.
