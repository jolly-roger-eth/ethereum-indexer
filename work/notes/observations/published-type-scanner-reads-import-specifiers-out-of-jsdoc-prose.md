---
title: 'The published-type dependency scanner reads import specifiers out of JSDoc PROSE'
slug: published-type-scanner-reads-import-specifiers-out-of-jsdoc-prose
---

2026-08-28, noticed while adding JSDoc to `packages/core/src/types.ts`.
`packages/core/test/publishedTypeDependencies.test.ts` scans the emitted `.d.ts` for import
specifiers without stripping comments, so an ordinary English sentence containing
`from "we never asked"` was reported as `core/dist/types.d.ts imports 'we never asked', which
is not declared at all` and turned the acceptance gate red. Reworded the prose to get past it;
the scanner itself is untouched.
