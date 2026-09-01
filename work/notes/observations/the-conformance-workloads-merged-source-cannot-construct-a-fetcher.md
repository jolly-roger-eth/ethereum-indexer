# The conformance workload's merged three-contract source can no longer construct a fetcher

**2026-09-01**, noticed while capturing `docs/spikes/replay-parse-cost/` (see
`work/notes/findings/replay-parse-cost.md`).

`LogEventFetcher`'s construction-time ambiguity guard (landed with #28, ADR-0034) refuses the whole
source when the merged ABI declares one event signature twice with different decoding shapes — and
the promoted conformance workload's source does exactly that: `Approval(address,address,uint256)`
is Stratagems' ERC-721-style event (`owner, approved, tokenID`) and Gems' ERC-20-style event
(`owner, spender, value`). So `new LogEventFetcher(provider, source.contracts, …)` THROWS for the
very source the repo's own workload measures with, meaning:

- `captureStream` cannot capture it again (the committed fixture predates the guard, from d635f39),
- the indexer's own load/replay path cannot construct over it, and
- the conformance tests cannot see this, because they replay through processors and never construct
  a fetcher — the green gate is blind to the refusal.

The refusal looks over-broad for this case: `decodeOnto` keys the ABI by the log's ADDRESS
(`abiPerAddress`), and the two Approvals live at different addresses, so the wire DOES tell them
apart — the guard's rationale ("nothing on the wire tells them apart") holds only for the
topic0-keyed all-ABI path, not the per-address one the fetcher actually uses per event. Either the
guard should tolerate same-signature/different-shape events when the per-address ABIs are each
unambiguous, or the conformance source needs a documented workaround. Not fixed here (the spike
routes per contract); worth a decision before anything needs to capture or replay this source
through the production path.