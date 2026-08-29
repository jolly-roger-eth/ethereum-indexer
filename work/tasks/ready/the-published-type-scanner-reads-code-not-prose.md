---
title: 'The published-type dependency scanner reads code, not prose'
slug: the-published-type-scanner-reads-code-not-prose
blockedBy: []
---

## What to build

`packages/core/test/publishedTypeDependencies.test.ts` scans the emitted `.d.ts` for import
specifiers WITHOUT stripping comments, so an import specifier written in an ordinary English
sentence inside JSDoc is read as a real dependency.

Observed on 2026-08-28 (`work/notes/observations/published-type-scanner-reads-import-specifiers-out-of-jsdoc-prose.md`):
a doc comment containing the phrase `from "we never asked"` produced

```
core/dist/types.d.ts imports 'we never asked', which is not declared at all
```

and reddened the acceptance gate. The author reworded the prose to get past it; the scanner was
left as it is.

This is a FALSE POSITIVE that fails a gate, which is the expensive direction. It punishes writing
explanatory comments, in a repository whose whole style is explanatory comments, and it will
recur. Worse, the workaround teaches the wrong lesson: it makes people quietly change what a
comment SAYS to satisfy a test that was never about comments.

Make the scan read declarations rather than text. Strip comments before scanning, or parse rather
than pattern-match. The test's real claim — that a published `.d.ts` must not import something the
package does not declare as a dependency — is a good claim and must keep working; only its reading
of the file changes.

Consider whether the same pattern-matching appears anywhere else that scans emitted output, and
say so either way in your report rather than silently fixing one instance.

## Acceptance criteria

- [ ] A `.d.ts` whose JSDoc prose contains an import-specifier-shaped phrase (`from "..."`, `import ... from '...'`, and the same inside a `@example` block) does NOT report a dependency.
- [ ] A genuine undeclared import is still caught, with the message it produces today.
- [ ] A genuine import inside a string LITERAL in code (not a comment) is still handled as it is today, whichever way that is; if the choice is arguable, record it in `## Decisions`.
- [ ] The regression is pinned by a test containing the exact shape that broke it: a comment carrying `from "we never asked"`.
- [ ] The reworded prose in `packages/core/src/types.ts` may be restored to what it was meant to say; if you restore it, the test above proves the scanner no longer cares.
- [ ] A changeset if any published behaviour changes; an explicit note in the report if none does.

## Blocked by

- None.

## Prompt

> Make `packages/core/test/publishedTypeDependencies.test.ts` read code rather than prose, in the
> `etherfold` monorepo.
>
> FIRST, reproduce it. Put a JSDoc comment containing the phrase `from "we never asked"` into a
> type that is emitted into `packages/core/dist/types.d.ts`, build, and confirm the test reports
> `imports 'we never asked', which is not declared at all`. If it no longer reproduces, route to
> needs-attention rather than changing anything.
>
> The claim the test makes is a good one and must survive: a published `.d.ts` must not import
> something the package does not declare as a dependency. What is wrong is only HOW it reads the
> file, scanning raw text so a sentence is indistinguishable from a declaration. Strip comments
> first, or parse the file properly; TypeScript is already a dependency here, so a real parse is
> available and is the honest fix.
>
> This matters more than one reworded sentence. The gate failing on a COMMENT teaches people to
> change what a comment says in order to satisfy a test that was never about comments, in a
> repository whose documentation style is long explanatory comments. That is a bad incentive worth
> removing at the root.
>
> Check whether anything else in the repo scans emitted output by pattern-matching text, and report
> what you found either way instead of quietly fixing a single instance.
>
> Record any non-obvious in-scope decision in a `## Decisions` block in your final report, and do
> not commit without confirmation.
