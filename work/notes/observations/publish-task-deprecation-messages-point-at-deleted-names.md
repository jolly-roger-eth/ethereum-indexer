# 2026-09-02: the publish task's deprecation messages point at two names that no longer exist

`work/tasks/backlog/publish-etherfold-and-deprecate-old-names.md` step 3 deprecates
`ethereum-indexer-fs` and `ethereum-indexer-fs-cache` with the reason "renamed to `@etherfold/fs`
/ `@etherfold/fs-cache` (ADR-0017)" — but `drop-filesystem-storage-and-rehome-the-fixture-loader`
deleted both `@etherfold` packages, so the new names those messages point at will never exist on
npm. When that task runs, those two deprecation reasons need rewording (the old flat names still
exist on npm and are still worth deprecating; the forward pointer is what went stale).