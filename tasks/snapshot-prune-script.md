# Add a manual script to prune outdated CLI snapshot files (LOW-5)

**Area:** `packages/ethereum-indexer-cli` (and/or `packages/ethereum-indexer-utils`)
**Type:** Investigation + Implementation (TDD)
**Status:** todo

## Context

This is **LOW-5** from the server/CLI batch audit (`tasks/findings/server-cli-batch.md`), deferred
from the fix task (`tasks/archive/fix-server-cli-batch.md`).

The CLI's `keepState` writes snapshot files whose **names are content-hashed** by
`contextFilenames(context)` (in `ethereum-indexer-utils`):

```
<networkString>-<sourceHash>[-<configHash>][-<version>]-state.json
<networkString>-<sourceHash>[-<configHash>][-<version>]-lastSync.json
```

where `networkString` is the chainId (plus genesisHash for local chains 1337/31337), `sourceHash`
is `simple_hash(source)`, `configHash` is `simple_hash(config)`, and `version` is the optional
processor version. So whenever the **source, config, or version changes**, a **new** file is written
and the **old one is left on disk forever** — nothing ever deletes it. Over many deploys the output
`folder` accumulates stale `*-state.json` / `*-lastSync.json`, and in the committed-snapshots repo
(`wighawag/stratagems-snapshots`) those dead files get committed.

## Decision (from discussion)

Do **not** auto-delete during indexing. Instead provide a **separate script the maintainer runs
manually** to prune outdated snapshots. Auto-deletion is risky: several snapshots can legitimately
coexist (multiple chains, intentionally-kept old versions for rollback/comparison), so a naive
"delete everything that isn't the current hash" could destroy a file someone still wants.

## Investigation FIRST (the hard part — do this before writing the deleter)

The key question: **how do we safely detect which snapshot files are "outdated"?** Things to work
out and confirm with the maintainer before deleting anything:

1. **What defines "current"?** A snapshot is keyed by `(network, sourceHash, configHash, version)`.
   "Current" likely means: the filename(s) `contextFilenames` would produce for the processor +
   source the project uses *right now*. But the prune script does not run the indexer — how does it
   learn the current context? Options to evaluate:
   - Re-derive it from the same inputs the CLI uses (processor module + deployments) — i.e. import
     the processor, build the source, call `contextFilenames`. (Most accurate; needs the same module
     load the CLI does.)
   - Or take an explicit allow-list / "keep" set from the user (chains/versions to keep).
2. **Pairing:** each snapshot is a `-state.json` + `-lastSync.json` pair sharing a prefix. Prune
   must treat the pair atomically (never delete one without the other).
3. **Multiple chains / multiple kept versions:** the script must support keeping more than one
   current snapshot (e.g. per chain, or "keep the last N versions"). Decide the policy and make it
   explicit (flags), not hardcoded.
4. **Genesis-hash naming for local chains** (1337/31337) — the prefix includes the genesisHash;
   make sure detection accounts for it.
5. **Unknown / foreign files:** the folder may also contain `event-stream.db` (server cache) or
   other files. The script must only ever consider `*-state.json` / `*-lastSync.json` it understands
   and must never touch anything else.

Capture the findings (how detection will work, the chosen policy, the safety rules) at the top of
the implementation or in a short note before coding the deletion.

## Suggested scope (after investigation)

- A script (e.g. `ei-prune-snapshots` bin, or `pnpm` script) that:
  - **defaults to dry-run** (lists what *would* be deleted) and requires an explicit `--yes` /
    `--delete` flag to actually remove files;
  - prints each pair it would delete and why (which (network/source/config/version) it maps to, and
    why it's considered outdated);
  - supports a "keep" policy (current context + optionally last-N versions / explicit keep-list);
  - never deletes unpaired or unrecognized files.
- Reuse `contextFilenames` (and a small parser for the prefix) from `ethereum-indexer-utils`.

## Workflow

- **Investigation first**, then **TDD with confirmation gates**: the detection/selection logic
  (given a directory listing + a "current/keep" set → which pairs are deletable) should be a pure,
  unit-tested function. Write tests for: a current pair is kept; a stale pair is selected; pairs are
  kept/deleted atomically; unrecognized files are never selected; multi-chain / keep-last-N policies.
  The actual `fs.unlink` wiring is a thin layer over that pure function.
- **Default to dry-run**; deletion only behind an explicit flag. Per repo safety guidelines, never
  delete without explicit user action.
- Changeset if it adds a published bin/behaviour to `ethereum-indexer-cli`.
- Do **not** auto-commit; present diffs.

## Prompt (paste into a fresh context)

---

Add a manually-run script to prune outdated CLI snapshot files. Read
`tasks/snapshot-prune-script.md` and the LOW-5 entry in `tasks/findings/server-cli-batch.md` first.
Background: CLI snapshot filenames are content-hashed by `contextFilenames` in
`ethereum-indexer-utils` (`<network>-<sourceHash>[-<configHash>][-<version>]-state.json` and the
matching `-lastSync.json`), so changing the source/config/version writes a new file and orphans the
old one — they are never cleaned up and get committed in the snapshots repo. We do NOT want
auto-deletion during indexing; we want a separate script run manually. FIRST investigate and confirm
with me how to safely detect "outdated" snapshots: how the script learns the current context
(re-derive via processor+deployments vs an explicit keep-list), atomic pairing of state/lastSync,
supporting multiple chains / keep-last-N versions, local-chain genesisHash naming, and never
touching unrecognized files. Then implement the selection logic as a pure, unit-tested function
(directory listing + keep-set → deletable pairs) with a thin fs layer on top. Default to dry-run;
require an explicit flag to actually delete. Use TDD with confirmation gates and add a changeset if
it adds a published bin. Do not commit without my confirmation.

---
