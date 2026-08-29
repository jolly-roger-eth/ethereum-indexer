---
title: 'Two ADRs cannot claim the same number'
slug: two-adrs-cannot-claim-the-same-number
blockedBy: []
---

## What to build

Nothing validates ADR numbering, so two ADRs can carry the same number and every gate stays green.

This is not hypothetical. On 2026-08-28 `docs/adr/0032-the-acceptance-gate-does-not-assume-an-idle-machine.md`
landed on `main` while a branch was in flight that already added
`docs/adr/0032-an-event-block-range-is-a-fetch-and-invalidation-fact-never-a-decoding-one.md`. Both
existed on the branch simultaneously, `format:check`, `build`, `typecheck` and `test` were all
green, and the collision was caught only because a human happened to list the directory. The second
was renumbered to 0033 by hand.

The failure is quiet and it gets worse with time: an ADR number is a STABLE REFERENCE. This repo
cites them from source comments (19 `vitest.config.ts` files point at ADR-0032), from `CONTEXT.md`,
from changesets and from other ADRs. Two documents sharing a number makes every one of those
citations ambiguous, and the ambiguity is discovered long after the merge that caused it, when the
context is gone.

It is also exactly the class of mistake concurrent work produces: neither branch is wrong on its
own, and each passes its own gate.

Add a check that fails when two files in `docs/adr/` share a leading number, naming both files. It
must run in the acceptance gate, since that is the thing that would have caught this.

Keep it cheap and dependency-free. A small node script wired into an existing root script is
enough; do not add a package, and do not reach for a linter framework. Prefer a root-level file so
no workspace package is touched, which also means no changeset is required.

While you are there, consider whether the check should also catch a MISSING number (a gap in the
sequence) or a malformed filename. A gap is probably fine and even expected, so if you decide not
to check it, say why in `## Decisions` rather than leaving it unaddressed.

## Acceptance criteria

- [ ] Two ADR files sharing a leading number fail the check, and the message names BOTH files and the number.
- [ ] The current `docs/adr/` contents pass.
- [ ] The check runs as part of the acceptance gate, so a colliding ADR cannot merge green.
- [ ] The check is dependency-free and adds no workspace package.
- [ ] A malformed ADR filename (no leading number) is either caught or explicitly out of scope, with the choice recorded in `## Decisions`.
- [ ] A test or a self-check demonstrates the failing case, rather than only the passing one; a validator that has never been seen to fail is not known to work.

## Blocked by

- None.

## Prompt

> Stop two ADRs claiming the same number, in the `etherfold` monorepo.
>
> FIRST, confirm the gap is real: check that nothing in the root scripts, `dorfl.json`'s `verify`,
> or CI validates `docs/adr/` filenames, and that the current directory has no collision left (0032
> and 0033 were separated by hand). If a check already exists, route to needs-attention.
>
> The motivating incident is worth reading, because it explains what the check is FOR. Two branches
> each added an ADR-0032 and neither was wrong on its own; the collision existed only in the merge,
> the full gate was green, and a human caught it by listing a directory. ADR numbers are stable
> references cited from source comments, `CONTEXT.md`, changesets and other ADRs, so a duplicate
> makes all of those ambiguous, and it is found long after the context is gone.
>
> Keep it small. A dependency-free node script wired into an existing root script is the right size.
> Do not add a workspace package and do not adopt a linting framework for this. A root-level file
> touches no package, which also means no changeset is needed; confirm that rather than assuming it.
>
> Make sure it runs in the acceptance gate. A validator that does not run where the mistake happens
> is decoration.
>
> Demonstrate the FAILING case, not just the passing one. A check that has never been observed to
> reject anything is not known to work.
>
> Record any non-obvious in-scope decision in a `## Decisions` block in your final report, and do
> not commit without confirmation.
