---
'@etherfold/core': minor
---

A payload whose blocks do not ascend is now REFUSED, where it used to be silently partly discarded. `feed()`'s cursor argument is now required.

The engine reads a payload in order. With an empty unconfirmed window the FIRST group's block number becomes the boundary above which events are new, and the next window is built in payload order, so a block arriving after a higher-numbered one was dropped without a word, and the window left behind was unordered, which made the following cycle's boundary wrong too. `assertWellFormed` checked that every log sat inside the batch's range but said nothing about their order, so an out-of-order payload crossed the wire and lost logs on arrival.

The check is applied at all three entry points: the wire (`assertWellFormed`), the host-fetch path (`feed()`), and the engine's own answer from the node. Equal block numbers are accepted, since a block holds many logs and their order within it is the node's `logIndex`.

**Refused rather than sorted, deliberately.** `eth_getLogs` answers in ascending order and nothing legitimate reorders it, so an unordered payload means something upstream is wrong: a merging proxy, a sharded provider reassembling shards, a host building a batch by hand. Sorting would paper over that and let the real fault resurface later as missing data; failing names it while it can still be traced. If a provider is found doing this legitimately, that is the point to revisit the decision with the evidence in hand.

`feed(events, cursor)`'s second argument is no longer optional. Omitting it substituted a fresh cursor with `latestBlock: 0`, which made every block unconfirmed regardless of depth and left `lastToBlock` at 0 for ever, so the generation never advanced. No caller omitted it, and its sibling `replay()` already required it.
