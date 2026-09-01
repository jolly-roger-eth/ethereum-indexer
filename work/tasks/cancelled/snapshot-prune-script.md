---
title: Add a manual script to prune outdated CLI snapshot files
slug: snapshot-prune-script
covers: []
blockedBy: []
needsAnswers: true
reason: superseded by retire-the-js-object-processor-path — the files this script would prune are written by the free-form `--store file` CLI arm, which ADR-0037 retires and which retire-the-js-object-processor-path deletes. Once that lands the file family no longer exists, so building a prune script for it is pure waste. Confirmed by maintainer.
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
4. **Is this worth building at all, given what it prunes is on a retirement path?** The files in
   question are the CLI snapshot files written by `packages/cli/src/keepState.ts` on the free-form
   `--store file` arm, and ADR-0037 retires that whole authoring path
   (`retire-the-js-object-processor-path`, which now explicitly owns removing the CLI arm). If the
   path goes, so does the file family this script prunes, and questions 1-3 would be answered
   against something that no longer exists. Decide the order deliberately: either build this before
   the retirement lands and accept it may be short-lived, or cancel it as superseded. Nothing else
   in the tree cross-references the two, which is why it is asked here.

<!-- /open-questions -->

## What to build

A manually-run script that prunes outdated CLI snapshot files. CLI snapshot filenames are content-hashed by `contextFilenames` in `@etherfold/utils` (`<network>-<sourceHash>[-<configHash>][-<version>]-state.json` + matching `-lastSync.json`), so changing source/config/version writes a new file and orphans the old one — never cleaned up, and committed in the snapshots repo. NOT auto-deleted during indexing (several snapshots can legitimately coexist). Instead: a separate script, **default dry-run**, explicit `--delete`/`--yes` to actually remove. Implement the selection logic as a **pure, unit-tested function** (directory listing + keep-set → deletable pairs) with a thin `fs.unlink` layer on top. Reuse `contextFilenames` + a small prefix parser.

## Acceptance criteria

- [ ] Pure selection function: given a dir listing + a current/keep set → the deletable pairs; unit-tested.
- [ ] Tests cover: current pair kept; stale pair selected; pairs kept/deleted ATOMICALLY; unrecognized files never selected; multi-chain / keep-last-N policies.
- [ ] Defaults to dry-run (lists what WOULD be deleted + why); deletion only behind an explicit flag.
- [ ] Never deletes unpaired or unrecognized files.
- [ ] Changeset if it adds a published bin/behaviour to `etherfold`.

## Blocked by

- None — can start immediately (but resolve the Open questions with the maintainer before writing the deleter).

## Prompt

> Add a manually-run script to prune outdated CLI snapshot files.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED). Specifically: confirm the free-form `--store file` CLI path still exists, because ADR-0037 retires it and `retire-the-js-object-processor-path` owns removing the CLI arm. If that has landed, the file family this script prunes is gone and this task should be cancelled rather than built — surface that instead of building (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> See the LOW-5 entry in `docs/reviews/server-cli-batch.md` first. Background: CLI snapshot filenames are content-hashed by `contextFilenames` in `@etherfold/utils` (`<network>-<sourceHash>[-<configHash>][-<version>]-state.json` and the matching `-lastSync.json`), so changing the source/config/version writes a new file and orphans the old one — never cleaned up, and committed in the snapshots repo. We do NOT want auto-deletion during indexing; we want a separate script run manually. FIRST investigate and confirm with the maintainer how to safely detect "outdated" snapshots: how the script learns the current context (re-derive via processor+deployments vs an explicit keep-list), atomic pairing of state/lastSync, supporting multiple chains / keep-last-N versions, local-chain genesisHash naming, and never touching unrecognized files. Then implement the selection logic as a pure, unit-tested function (directory listing + keep-set → deletable pairs) with a thin fs layer on top. Default to dry-run; require an explicit flag to actually delete. Use TDD with confirmation gates and add a changeset if it adds a published bin. Do not commit without confirmation.
