---
'@etherfold/server': minor
'@etherfold/core': minor
---

EVERY FEED RESPONSE SAYS WHICH GENERATION ANSWERED IT.

Both views over the stored emission stream (`GET /{indexer}/feed` and `GET /{indexer}/canonical`) now carry `generation` on every answer they give, pages and refusals alike, beside the `stream` they already carried.

```json
{"success": true, "stream": "…", "generation": "<opaque>", "entries": [], "cursor": "<opaque>", "hasMore": false}
```

**It exists for the one change no cursor check can catch.** A `seq` is a position in a STREAM, so a move to a generation over the SAME stream leaves every cursor valid, and a move to one on a DIFFERENT stream is already refused by the cursor's stream component. What is left is SAME LOGS, DIFFERENT FOLD: nothing in a cursor can see it, and a consumer reading state alongside the feed has to be told. The cursor is opaque, so a readable field beside it is the only thing a consumer can compare across polls.

**The value is OPAQUE: compared, never parsed.** `generationDigestOf` (`@etherfold/core`) renders a `GenerationId` -- the stream digest plus the processor's version hash -- as one 128-bit hex digest, so what a generation is composed of can change without a consumer noticing. The registry keeps the two halves as separate fields because it KEYS on them; a value reported outward is not a key, and a consumer handed two named fields would read one of them.

**A processor change costs a feed consumer nothing but the notice.** Its cursor stays valid, the delivered logs are byte-identical, and no generation column is added to the log table -- which is exactly what makes such a change free.

**The platform ADVERTISES and does not DICTATE.** There is no rule about what a consumer does when the value moves: pausing, re-scanning and carrying on are all legitimate, and only the consumer knows whether its own actions can be taken back.

**`LogIngestion` grows `generation`** (`@etherfold/core`), the `{stream, processor}` identity of the receiver, derived on every read rather than snapshotted: `getVersionHash()` covers a processor's configuration as well as its version, so a value captured at construction can stop being true. `StreamBuilder` supplies it; a host that implements the interface itself now supplies one too.
