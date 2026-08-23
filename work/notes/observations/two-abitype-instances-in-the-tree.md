---
title: 'Two `abitype` instances resolve in the workspace (1.2.4 direct, 1.2.3 under viem)'
slug: two-abitype-instances-in-the-tree
observed: 2026-08-23
source: 'task:typecheck-tests-in-the-acceptance-gate, while reading tsc errors that mentioned "Two different types with this name exist, but they are unrelated"'
---

`@etherfold/core` declares `abitype: ^1.2.4` and resolves 1.2.4, while its `viem@2.52.0` pins `abitype@1.2.3`, so `node_modules/.pnpm` holds both. `core` re-exports abitype's types (`Abi`, `AbiEvent`, `ExtractAbiEvent`, ...) as part of its own public surface, and viem-derived types in the same program carry the 1.2.3 copies, so structurally identical types from the two copies are not mutually assignable.

Not confirmed to bite anything today: the errors that first drew attention to it turned out to have a different cause (a mapped type defeating generic inference) and are fixed. Recording it because the two-instance condition is real and is exactly the shape that produces unreadable "two different types with this name" diagnostics for a downstream consumer.
