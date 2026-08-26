---
'@etherfold/core': minor
---

`createDirectIngestion`: the ADR-0004 wire, with no wire.

The split of ADR-0003 was always meant to be a DEPLOYMENT choice rather than two implementations, and this is the eighteen lines that make that literally true. Both sides of the contract are interfaces (`IngestionTarget` for the sender, `LogIngestion` for the receiver), so `createDirectIngestion(streamBuilder)` hands a `LogFetcher` straight to a `StreamBuilder` in the same process, and one deployable fetches and processes while running exactly the code a split deployment runs.

What survives is nearly all of it, because none of it came from HTTP: the receiver is still authoritative about the cursor, still derives every reorg, and still refuses a batch that does not start where it says; the fetcher still holds no cursor, still asks before its first fetch, and is still corrected rather than crashed when it asks from the wrong place. What is lost is what the transport was carrying: a network hop, a shared secret, and the two failure modes that go with them.

**The one thing it must get right is that a cursor refusal is a correction and not a fault.** Over HTTP that is the `409`; here it is a thrown `UnexpectedFromBlockError`, and a sender that received it as an exception would treat the ordinary case (a restart, a lost acknowledgement, a second fetcher) as a crash. It is recognised STRUCTURALLY rather than with `instanceof`, for the same reason `retryable` is read structurally: two copies of this package in one dependency tree would otherwise turn the resumable refusal into a fault, and only in the deployments that bundle awkwardly. Every other refusal passes through untouched, `retryable` flag included, since there is no status code here to flatten it into.

Which deployment this is for: one that can hold a PROCESS, since that is what driving the chain needs. A serverless runtime is a good home for the receiving half and a poor one for the fetching half, so the two shapes worth having are a Node process that pushes over HTTP to an indexer-server anywhere (a Worker among them), and a Node process that runs both halves with this in the middle.
