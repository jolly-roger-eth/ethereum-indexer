# Archive

Retired packages, kept as reading material. **Nothing in here is built, typechecked, tested, versioned or published.**

`archive/` is deliberately outside the `pnpm-workspace.yaml` globs (`packages/*`, `examples/*`, `platforms/*`), so `pnpm install`, `pnpm build`, `pnpm typecheck`, `pnpm test` and `changeset` do not see these directories at all. That is the whole point: keeping them buildable is a standing tax on every dependency bump and every seam change, and deleting them outright loses the only readable copy of code that later work still refers to.

A consequence to expect: the manifests in here still carry `workspace:*` dependencies that no longer resolve, so these packages cannot be installed as-is. Git history is the record of when they last worked.

## What is here

| directory | package | retired by |
| --- | --- | --- |
| `ethereum-indexer-server/` | `ethereum-indexer-server` (bin `eis`) | [ADR-0010](../docs/adr/0010-delete-db-processors-retire-db-utils-with-the-indexer-server.md), superseded by ADR-0003's split server (`@etherfold/server` + `@etherfold/platform-nodejs`, driven by `etherfold serve`) |
| `ethereum-indexer-db-utils/` | `ethereum-indexer-db-utils` | [ADR-0010](../docs/adr/0010-delete-db-processors-retire-db-utils-with-the-indexer-server.md), whose central role [ADR-0006](../docs/adr/0006-store-the-emission-stream-derive-the-canonical-view.md) supersedes |

ADR-0010 put both on a retirement path and named the trigger: *"the indexer-server landing, not a date."* It has landed, so they moved here.

`ethereum-indexer-db-processors` is NOT here. ADR-0010 deleted it outright, because the artifact worth keeping was the analysis rather than the code, and that is extracted into [`docs/reviews/revertable-database.md`](../docs/reviews/revertable-database.md).

## Why keep them at all

They are the source the design documents read against, and the paths in those documents still point at `packages/`:

- [`docs/reviews/event-cache.md`](../docs/reviews/event-cache.md) analyses `EventCache`, `StreamDBCache` and the `Database` interface, now at `archive/ethereum-indexer-db-utils/src/`. ADR-0010 keeps it live precisely because that code is being **re-homed** into the stream-builder rather than discarded, and its known bugs (notably `replay()` reconstructing `lastSync` with empty `unconfirmedBlocks`) must not be carried across.
- [`docs/reviews/server-cli-batch.md`](../docs/reviews/server-cli-batch.md) audits `SimpleServer` and `runServer()`, now at `archive/ethereum-indexer-server/src/`.

Read `packages/ethereum-indexer-<name>/` as `archive/ethereum-indexer-<name>/` in both.

## What this does NOT do

It does not touch npm. Both names are still published and installable, and they are deliberately **not** deprecated: `publish-etherfold-and-deprecate-old-names` covers the registry side, and it deprecates only the seven packages ADR-0017 renamed. These two were never renamed, they retire under a different decision, and conflating the two would mislead anyone still on them.

It also does not release the work that was done on them and never shipped. `ethereum-indexer-server`'s `CHANGELOG.md` carries that record under an `Unreleased` heading, moved there from `.changeset/` when the release path was cleared, because a changeset naming a package outside the workspace makes `changeset status` fail outright.
