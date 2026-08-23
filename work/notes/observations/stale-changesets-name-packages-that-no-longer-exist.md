---
title: '`pnpm changeset status` fails outright: pending changesets name pre-rename packages'
slug: stale-changesets-name-packages-that-no-longer-exist
observed: 2026-08-23
source: 'task:query-surface-from-entity-declarations, while checking this task own changeset'
---

`pnpm changeset status` (no `--since`) errors with `Found changeset bigint-literal-guard-and-hash-prefix for package ethereum-indexer which is not in the workspace`: several pending changesets in `.changeset/` still name the pre-`etherfold` package names. The acceptance gate only runs `changeset status --since=main`, which considers changesets added since main and therefore passes, so this is invisible until someone runs a plain status, `changeset version`, or a release.

Not touched here. Recorded because the rename (`rename-to-etherfold`, ADR-0017) left the unreleased changeset backlog behind, and `publish-etherfold-and-deprecate-old-names` is the task that will meet it.
