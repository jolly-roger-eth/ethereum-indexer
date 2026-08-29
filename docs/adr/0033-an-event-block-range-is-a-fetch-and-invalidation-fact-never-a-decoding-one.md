# An event's block range is a fetch-and-invalidation fact, never a decoding one

An ABI event entry may declare the block range it is live over (`firstBlock`, and an optional `lastBlock`, both INCLUSIVE), and the indexer uses that range for exactly two things: whether a source change can be absorbed without re-fetching, and — later — which topics a given block range needs to request. It is deliberately NOT consulted when a log is decoded: `parse()` selects an ABI by address and `topic0`, with no block axis, exactly as it did before ranges existed.

## Considered options

**Per-range ABI BUCKETS with a block axis in `parse()`** — so a log decodes with "the ABI live at its block" — is what the originating spec argued for, and it was rejected on two independent grounds. The boundary block is **unknowable in advance**, so a live indexer following a proxy it has not been upgraded through yet can never fill it in; and it is **not block-granular anyway**, because the upgrade transaction sits mid-block and logs on either side of it share a block, so no block boundary separates them. The boundary was never needed for decoding in the first place: two versions with different signatures have different `topic0`s and are told apart on the wire (ADR-0031), and two versions sharing a `topic0` cannot be told apart by a boundary either, so that case stays REFUSED rather than resolved.

**An EXCLUSIVE `lastBlock`** was rejected because the off-by-one it invites is silent. With inclusive bounds, an upgrade at block `b` is declared `A.lastBlock = b` together with `B.firstBlock = b` — the same number twice, and the resulting one-block overlap is CORRECT, because a transaction earlier in `b` still fires A. With an exclusive end the correct declaration reads `b + 1`, and the obvious thing to type drops every pre-upgrade log in block `b`, undetectably.

**Reusing `startBlock`** was rejected because per-contract `startBlock` already means "do not look before here" and is MINIMISED across contracts by `defaultFromBlockOf`; a per-event range sharing that name or shape would silently drag the first fetched block down to it.

**Computing invalidation on the RAW entry list** was rejected because whatever generates a source usually cannot tell an upgrade from a cancellation: it appends on a proxy upgrade and appends again on a rollback, so a source legitimately reads `[A@a, B@b, A@c]`. `indexerMatches` compares element-wise BY INDEX, so the redundant third entry would shift the list and re-index the world for a coverage that did not move. Entries are therefore derived from the NORMALISED ranges (an open-ended occurrence absorbs the rest from the minimum `firstBlock`; otherwise the union), which makes that append a genuine no-op.

## Consequences

A GAP between two ranges of one event is REFUSED at construction, naming the event and the uncovered span, because a hole is a span nobody requests and afterwards nothing distinguishes "the chain had none" from "we never asked". Overlap is not a gap and is never refused.

A `lastBlock` is an assertion the indexer acts on and cannot verify, and both bounds are asymmetric in the same direction: `firstBlock` too EARLY and `lastBlock` too LATE cost a little redundant fetching, while `firstBlock` too LATE and `lastBlock` too EARLY lose logs undetectably.

A source that declares NO range still produces the single whole-source context entry it always did, so `ContextIdentifier` keeps its stored shape, every persisted value stays readable, and no existing deployment changes behaviour merely by upgrading.

The invalidation decision (`sourceInvalidationOf`) names the BLOCK from which stored data stopped being valid, even though the only action taken on it today is a full discard. That is what keeps stream branching (`work/notes/ideas/a-stream-branches-instead-of-being-discarded.md`) a later refinement rather than a rewrite.

Until the follow-up narrowing lands, every fetched range still carries every topic. That is wasteful and correct; nothing regresses.
