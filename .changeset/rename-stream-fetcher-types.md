---
'ethereum-indexer': minor
'ethereum-indexer-browser': minor
---

Rename misspelled public types `StreamFecther` → `StreamFetcher` and `ExistingStateFecther` → `ExistingStateFetcher`.

This is a breaking change for any code importing these types by name (no deprecated aliases are kept). Update your imports accordingly.
