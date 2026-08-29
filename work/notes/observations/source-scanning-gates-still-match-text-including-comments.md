---
title: 'The source-scanning gates still match TEXT, so a comment can fail them'
slug: source-scanning-gates-still-match-text-including-comments
---

2026-08-29, noticed while making `packages/core/test/publishedTypeDependencies.test.ts` parse
instead of pattern-match. That was the only gate reading EMITTED output, but four more read `src/`
the same way, and their whole-file matchers do not require an import at all: a COMMENT that
mentions the forbidden thing fails them. `packages/state-store-sqlite/test/no-platform-leakage.test.ts`
asserts `not.toMatch(/\bD1\b/)` and `not.toMatch(/cloudflare/i)` over the whole file, so explaining
in a doc comment why this store must not name D1 would redden the gate; `stays-light.test.ts`,
`stays-a-primitive.test.ts` and `packages/server/test/platformAgnostic.test.ts` do the same with
`\bconsole\.` and `\bD1Database\b`. (Their `^\s*import ... from '...'` scans are anchored and much
safer.) Separately, `packages/state-store-patch/test/historical-reads.test.ts` slices a method body
out of `src/store.ts` by string index and regexes that, so a comment inside the body counts as code.
Not touched: outside the task that found it.
