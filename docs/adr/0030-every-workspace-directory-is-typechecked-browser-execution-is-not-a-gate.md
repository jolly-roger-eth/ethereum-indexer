# Every workspace directory is typechecked; browser execution is deliberately not a gate

The acceptance gate now typechecks **every** workspace project, `examples/` included, and continues to run **no browser** in that gate. Those are two separate answers to two questions that kept getting asked together, and answering them together is what produced the hole this ADR closes.

## The hole

`typecheck`, `test` and `build` all filtered to `./packages/*` and `./platforms/*`, so nothing under `examples/` was ever reached. Each example's own `tsconfig.json` then narrowed further to `src/**/*.ts`, so even building an example directly did not look at code beside it. What compiled `examples/event-processor-nfts/browser/main.ts` -- roughly 300 lines of application code -- was `vite build`, which strips types without checking them.

The measured consequence, on turning the gate on: three type errors in that one file (including a chain-mismatch check reading a property the annotation said did not exist), one `null`-topic filter the package's own type cannot express, and 24 more across the two Svelte demos -- among them `examples/mud/src/config.ts` importing `./lib/utils/web`, **a module that never existed in the two years since the example landed**. That last one is the whole argument in miniature: `vite build` was green because nothing imports `config.ts`, so the bundler never followed the broken import. A bundler checks what it bundles. A typechecker checks the directory.

## What was decided

1. **Every workspace project is in `typecheck`,** via a third `--filter './examples/*'`, with each example carrying a `tsconfig.typecheck.json` whose include is the WHOLE package -- the same convention the packages already use, and for the same reason: a glob listing the directories that happen to hold code today silently stops covering the next one.
2. **Browser execution stays out of the gate.** `@etherfold/browser`'s Playwright run, `@etherfold/state-store-indexeddb`'s, and the examples' browser verification are all run deliberately, never by `verify`.

## Why the second half is not cowardice

This is the third time the question has been weighed (`typecheck-tests-in-the-acceptance-gate` for tests, ADR-0024 for the IndexedDB browser run, and now this), and it lands in the same place each time, so it is recorded here once rather than re-litigated per example. A browser run needs `playwright install` and browser binaries a clean checkout does not have; some of them additionally need a live RPC endpoint. **A gate that cannot run on a clean checkout is a gate that gets skipped**, and a skipped gate is worse than an absent one because it is believed.

## The honest limit, which is the reason to write this down

**Typechecking `examples/` would have caught NEITHER of the two bugs that motivated it.** A temporal-dead-zone crash on an already-settled store subscription is not a type error (TypeScript does not track TDZ through a closure). Nor is a chain check that asks a pinned provider wrapper for `eth_chainId` and compares a constant with itself: it is perfectly well typed and answers `1` forever. Both were found by driving a real Chromium, and both would sail through `tsc` today.

So the two halves cover different failures and neither substitutes for the other:

- **In the gate:** does this code still typecheck. Cheap, hermetic, catches drift and rot, and would have caught the missing module and the too-narrow annotation.
- **Out of the gate, run deliberately:** does this code still WORK in an engine. Catches the two that shipped.

The rule that follows, and the one worth enforcing at review: **a claim about browser behaviour is only closed by a browser run.** Building green is not evidence. Where a browser check exists it is named in the package's `test:browser` / `verify:browser` script, and a change to that behaviour is expected to have run it.
