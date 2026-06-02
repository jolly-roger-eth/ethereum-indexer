# Refactor: extract the duplicated processor/source setup shared by CLI and server (LOW-4)

**Area:** `packages/ethereum-indexer-cli`, `packages/ethereum-indexer-server`, `packages/ethereum-indexer-utils`
**Type:** Refactor (TDD)
**Status:** done

## Context

This is **LOW-4** from the server/CLI batch audit (`tasks/findings/server-cli-batch.md`). It was
deferred out of the fix task (`tasks/archive/fix-server-cli-batch.md`) because it is a cross-package
refactor rather than a bug fix.

The CLI's `init()` (`packages/ethereum-indexer-cli/src/index.ts`) and the server's `setupIndexing()`
(`packages/ethereum-indexer-server/src/server/simple.ts`) contain **near-identical, copy-pasted**
logic for turning a processor module path + options into a `{processor, source, provider}`:

1. Import the processor module by path (absolute vs `process.cwd()`-relative; the server has an extra
   `createRequire(...).resolve()` fallback the CLI lacks).
2. Resolve the `createProcessor` factory and instantiate the processor.
3. Resolve contract data: `processorModule.contractsDataPerChain[chainId]` → fallback
   `processorModule.contractsData`, fetching `eth_chainId` when needed.
4. Build the `source` (`{chainId, contracts}`), or use `loadContracts(deployments)` when deployments
   are provided.

The CLI source even carries a literal `// TODO ethereum-indexer-server could reuse` comment.

## Why it matters

The two copies have **already diverged** and will keep drifting:

- **Processor factory args differ:** the CLI calls `processorFactory()` (no args); the server calls
  `processorFactory(this.config.folder)`. (This is also MEDIUM-3 in the findings — processor
  construction config is not reflected in the snapshot context.)
- **Module resolution differs:** the server has a `createRequire(...).resolve()` fallback; the CLI
  does not.
- **Logging differs** (`logger` vs `namedLogger`, `console.error` placement).

A single shared helper removes the drift risk and is the obvious home for any future improvement to
processor/source resolution.

## Suggested scope

- Add a shared helper in `ethereum-indexer-utils` (the package both already depend on), e.g.
  `resolveProcessorAndSource({processorPath, deployments?, processorConfig?, provider, ...})`
  returning `{processor, processorModule, source}` (or split into `loadProcessorModule` +
  `resolveSource` if cleaner). Keep the `createRequire` fallback (superset behaviour).
- Make the **processor factory argument** an explicit, documented parameter so the CLI/server
  difference is intentional rather than accidental (decide: should the CLI also pass a folder/config?
  Coordinate with MEDIUM-3 / the snapshot context).
- Rewrite CLI `init()` and server `setupIndexing()` to call the helper. Keep each package's own
  provider construction (the server now has a `createProvider` seam; the CLI uses
  `JSONRPCHTTPProvider` with `requestsPerSecond`).

## Workflow

- **TDD with confirmation gates** (same pattern as the archived fix task): the helper is pure and
  easily unit-tested (fake processor module object + fake provider). Write characterization tests
  for the current resolution behaviour FIRST (both the `contractsDataPerChain` and `contractsData`
  paths, the `loadContracts` path, and the error cases: no factory / no chainId / no contracts),
  then refactor and keep them green.
- Behaviour must be preserved for each caller (mind the intentional factory-arg difference — make it
  a parameter, do not silently unify it).
- Stand up / reuse vitest in `ethereum-indexer-utils` if not already present.
- Published-package API/behaviour changes need a **changeset** (utils minor for the new export; cli /
  server patch).
- Do **not** auto-commit; present diffs.

## Prompt (paste into a fresh context)

---

Extract the duplicated processor/source setup shared by the CLI (`init()` in
`packages/ethereum-indexer-cli/src/index.ts`) and the server (`setupIndexing()` in
`packages/ethereum-indexer-server/src/server/simple.ts`) into a shared helper in
`ethereum-indexer-utils`. Read `tasks/refactor-cli-server-setup-duplication.md` and the LOW-4 entry
in `tasks/findings/server-cli-batch.md` first. The two copies resolve a processor module + contract
data + source nearly identically but have already diverged (CLI calls `processorFactory()` with no
args, server calls `processorFactory(folder)`; the server has a `createRequire` resolve fallback the
CLI lacks). Add a tested helper (keep the `createRequire` fallback as the superset; make the
processor-factory argument an explicit parameter so the difference is intentional), and rewrite both
callers to use it while preserving each one's behaviour. Use TDD: write characterization tests for
the current resolution paths (`contractsDataPerChain`, `contractsData`, `loadContracts`, and the
no-factory / no-chainId / no-contracts errors) FIRST, then refactor and keep them green. Add
changesets (utils minor; cli/server patch). Do not commit without my confirmation.

---
