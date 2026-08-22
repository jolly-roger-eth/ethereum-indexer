---
'@etherfold/state-store-sqlite': minor
'@etherfold/processor-sqlite': minor
'@etherfold/js-processor': minor
'@etherfold/browser': minor
'@etherfold/fs-cache': minor
'@etherfold/utils': minor
'@etherfold/core': minor
'etherfold': minor
'@etherfold/fs': minor
---

Renamed to the `@etherfold` scope (ADR-0017). `ethereum-indexer` is now `@etherfold/core`, and `ethereum-indexer-browser`, `-js-processor`, `-fs`, `-fs-cache` and `-utils` are now `@etherfold/browser`, `@etherfold/js-processor`, `@etherfold/fs`, `@etherfold/fs-cache` and `@etherfold/utils`. The two previously unpublished `@ethereum-indexer/*` packages move to `@etherfold/*`.

The CLI is the one exception to the scope: `ethereum-indexer-cli` becomes the flat package **`etherfold`**, because it is the package that installs the `etherfold` command.

No API changed: update the package name in your imports and the exports are identical.

**You must migrate to keep receiving updates.** There is no re-export shim under the old names, so nothing further will be published as `ethereum-indexer*` and no version of an old name forwards to the new one. Already-published versions stay installable indefinitely, so existing pins keep resolving, but they are frozen.

**The CLI command is renamed**: the CLI installs `etherfold` instead of `ei`, so `npm i -g etherfold` then `etherfold -p <processor>`. Update any script that shells out to `ei`.

`named-logs` namespaces follow the package names, so any log filter matching `ethereum-indexer*` needs updating to `@etherfold/*`. The CLI is the exception: its namespaces follow the command, so `ei` and `ei:keepState` become `etherfold` and `etherfold:keepState`.

`ethereum-indexer-server` and `ethereum-indexer-db-utils` are deliberately NOT renamed: both are on the retirement path set by ADR-0010.
