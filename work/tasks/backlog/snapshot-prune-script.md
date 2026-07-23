---
title: Add a manual script to prune outdated CLI snapshot files
slug: snapshot-prune-script
covers: []
blockedBy: []
needsAnswers: true
---

<!-- open-questions -->
<!--
  TRANSIENT BLOCK — the safe-detection design must be confirmed with the maintainer
  BEFORE the deleter is written (deletion is destructive). Clear needsAnswers + delete
  this block once the detection policy is settled.
-->

## Open questions

1. How does the prune script learn the CURRENT context without running the indexer — re-derive via processor module + deployments (call `contextFilenames`), or take an explicit keep-list?
2. Keep policy: current context only, or keep-last-N versions, or an explicit allow-list? Multiple chains?
3. Confirm the safety rules: atomic state/lastSync pairing; local-chain (1337/31337) genesisHash naming; NEVER touch unrecognized files (e.g. `event-stream.db`).

<!-- /open-questions -->

## What to build

A manually-run script that prunes outdated CLI snapshot files. CLI snapshot filenames are content-hashed by `contextFilenames` in `ethereum-indexer-utils` (`<network>-<sourceHash>[-<configHash>][-<version>]-state.json` + matching `-lastSync.json`), so changing source/config/version writes a new file and orphans the old one — never cleaned up, and committed in the snapshots repo. NOT auto-deleted during indexing (several snapshots can legitimately coexist). Instead: a separate script, **default dry-run**, explicit `--delete`/`--yes` to actually remove. Implement the selection logic as a **pure, unit-tested function** (directory listing + keep-set → deletable pairs) with a thin `fs.unlink` layer on top. Reuse `contextFilenames` + a small prefix parser.

## Acceptance criteria

- [ ] Pure selection function: given a dir listing + a current/keep set → the deletable pairs; unit-tested.
- [ ] Tests cover: current pair kept; stale pair selected; pairs kept/deleted ATOMICALLY; unrecognized files never selected; multi-chain / keep-last-N policies.
- [ ] Defaults to dry-run (lists what WOULD be deleted + why); deletion only behind an explicit flag.
- [ ] Never deletes unpaired or unrecognized files.
- [ ] Changeset if it adds a published bin/behaviour to `ethereum-indexer-cli`.

## Blocked by

- None — can start immediately (but resolve the Open questions with the maintainer before writing the deleter).

## Prompt

> Add a manually-run script to prune outdated CLI snapshot files. See the LOW-5 entry in `docs/reviews/server-cli-batch.md` first. Background: CLI snapshot filenames are content-hashed by `contextFilenames` in `ethereum-indexer-utils` (`<network>-<sourceHash>[-<configHash>][-<version>]-state.json` and the matching `-lastSync.json`), so changing the source/config/version writes a new file and orphans the old one — never cleaned up, and committed in the snapshots repo. We do NOT want auto-deletion during indexing; we want a separate script run manually. FIRST investigate and confirm with the maintainer how to safely detect "outdated" snapshots: how the script learns the current context (re-derive via processor+deployments vs an explicit keep-list), atomic pairing of state/lastSync, supporting multiple chains / keep-last-N versions, local-chain genesisHash naming, and never touching unrecognized files. Then implement the selection logic as a pure, unit-tested function (directory listing + keep-set → deletable pairs) with a thin fs layer on top. Default to dry-run; require an explicit flag to actually delete. Use TDD with confirmation gates and add a changeset if it adds a published bin. Do not commit without confirmation.
