---
'@etherfold/processor-entities': patch
'@etherfold/processor-sqlite': patch
'@etherfold/js-processor': patch
---

Follow-on from the tagged BigInt codec landing everywhere: no behaviour change in any of these three, but they each referred to the convention that is gone.

`@etherfold/processor-sqlite`'s deployment-shapes test simulated the wire crossing with `bnReplacer` / `bnReviver`, which no longer exist; it now crosses through the REAL `serializeWireBatch` / `parseWireBatch`, so it exercises what a deployed log-fetcher and receiver actually put on the wire. `@etherfold/js-processor`'s version test carried an inline copy of the old suffix reviver to stand in for "the same convention the real keepers use", and now uses the codec those keepers actually use. `@etherfold/processor-entities`' sync-cursor note said the tagged codec was shared with the wire; it is now the repo's only BigInt convention, and says so.
