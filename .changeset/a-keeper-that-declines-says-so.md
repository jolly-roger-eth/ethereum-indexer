---
'@etherfold/core': minor
---

A stream keeper that DECLINES a batch now says so, instead of returning as though it had written it.

`createSegmentedStream.saveNewEvents` refuses a batch that does not continue what is stored, because appending it would leave a hole behind a cursor claiming to cover it. That refusal was a log line and an ordinary return, so the indexer could not tell it from a write: it advanced `streamLastToBlock` to a block the stream never received, and from then on its own hole-check compared against a mark that had already lied, so every later decline went unnoticed too. The whole write-outcome apparatus, which exists for exactly this failure, was bypassed by it.

`StreamSaver` may now return `'declined'`. Returning nothing still means "written", so existing keepers are unaffected and the change is additive.

A decline remains a cache degradation and not an indexing failure: unlike a FAILED write, it is not retried and it does not stop the fold, because retrying cannot help and the batch is wrong for this stream rather than the write being broken. What is stored stays the contiguous prefix it already was, and is replayed with the remainder re-fetched the next time the state is rebuilt. What changes is only that the indexer no longer records coverage it does not have.
