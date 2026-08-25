---
title: 'The committed snapshot-size numbers were measured under the retired `"123n"` BigInt encoding, so a re-measurement today would come out larger'
slug: snapshot-size-measured-under-the-retired-bigint-encoding
observed: 2026-08-25
source: 'noticed while driving task:tagged-bigint-codec-across-storage-adapters, sweeping the workspace for private copies of the BigInt codec'
---

`docs/spikes/bootstrap-an-entity-store-from-a-snapshot/measure-snapshot-size.ts` carries its own `bnReplacer` and measures snapshot bytes with the `"123n"` suffix form. Every storage adapter has now moved to the tagged form (`{"__bigint__": "123"}`), which is longer, so the committed `results/` numbers (and anything quoting them, e.g. ADR-0028) are bytes under an encoding the repo no longer writes.

The script was left as it was on purpose, so its committed numbers stay reproducible; only its comment was corrected. Whether the measurement is worth re-running, and whether the gzipped figures move at all (the tag is highly repetitive, so they may barely), is unexamined.
