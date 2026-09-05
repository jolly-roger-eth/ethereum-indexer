---
'@etherfold/core': minor
'@etherfold/platform-nodejs': patch
---

A receiver now says WHAT it emitted and WHICH STREAM it folds, so a host can store the emission stream without deriving either for itself.

`LogIngestion` gains `streamDigest`, the wide `streamDigestOf` value over the fetch filter plus the resolved stream config: the same name a stream has in the browser's stream address (ADR-0035), so one stream is one name everywhere. It is deliberately not `context`: the wire identity is a CHANGE DETECTOR between the two halves of one deployment, 32-bit per entry and over the whole entry on purpose (ADR-0034), so it moves on a decode-only change the fetch filter never saw and it collides. Neither is survivable in a KEY.

`IngestionOutcome` gains `emissions`, the ordered stream of what was applied and what was taken back, with retractions carrying their original block. It is REPORTED for the same reason `reorg` is: `StreamBuilder.receive` is the one place that knows what the fold concluded, and a host that re-derived it would be holding a second answer. The `applied` / `retracted` counts are that list partitioned on `removed` and stay, so a caller that only reports progress need not walk it.

`EmittedLog` is exported: one entry of that stream with the ABI taken away, which is to say the raw log the node reported plus the verdict. Taking the ABI away is the point, since a host that STORES logs is not a host that decodes them, and the decoded `args` are what some earlier ABI made of those bytes and are re-derived on replay against the source running now.

Breaking for anyone implementing `LogIngestion` by hand (a fake in a test): both new members are required. Neither is optional, deliberately. An optional field on the fold's output is a hole with a polite name, and a receiver that quietly omitted one would leave a host storing nothing under a key it could not form. The Node adapter's own fake receiver is updated for that reason and its behaviour is otherwise unchanged.
