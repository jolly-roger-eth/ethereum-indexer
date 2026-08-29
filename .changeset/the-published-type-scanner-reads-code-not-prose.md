---
'@etherfold/core': patch
---

The published-type dependency scanner reads declarations rather than text.

`packages/core/test/publishedTypeDependencies.test.ts` asserts that every package a published `.d.ts` imports from is a real dependency, which is a good claim: a type-only import is erased from the emitted `.js` but SURVIVES in the emitted `.d.ts`, so a package whose public types name `abitype` or `eip-1193` and declares neither is broken for whoever installs it. What was wrong was only HOW it read the file. It pattern-matched `from '...'` over the raw text, where a sentence is indistinguishable from a declaration, so a doc comment reading `nothing distinguishes "the chain had none" from "we never asked"` was reported as `core/dist/types.d.ts imports 'we never asked', which is not declared at all` and turned the acceptance gate red.

A false positive that fails a gate is the expensive direction, and this one taught the wrong lesson: the author reworded the COMMENT to get past a test that was never about comments, in a repository whose whole documentation style is long explanatory comments. It would have recurred on every one of them.

The scan now parses the declaration file with TypeScript (already a dependency here) and reads module specifiers out of the four positions a `.d.ts` can actually name a module in: `import`/`export ... from`, `import('x')` types, `import x = require('x')`, and a dynamic `import()` call. Those are positions no comment and no string literal can occupy. The claim is unchanged and a genuine undeclared import still fails with the same message.

The only published change is a doc comment: `RangedAbiEvent`'s explanation of which way to err on `firstBlock` says `nothing distinguishes "the chain had none" from "we never asked"` again, which is the phrase used for this failure class everywhere else in the repo (ADR-0031, ADR-0033). Its presence in the emitted `dist/types.d.ts` is now what proves the scanner no longer cares.
