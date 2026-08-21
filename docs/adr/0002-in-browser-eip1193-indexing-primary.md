# In-browser EIP-1193 indexing is the primary design axis

The indexer is designed so an indexer can run **client-side, in the browser**, over a plain EIP-1193 provider — for **decentralization** (each client can index for itself, no trusted server required). This shapes the whole processor contract and is a deliberate constraint, not an accident of the code.

## Consequences

- The core stays EIP-1193-first and must not require a server to function.
- **Batch RPC IS allowed** (`providerSupportsETHBatch`) — an earlier framing that batch was off-limits is inaccurate; batch is used where the provider supports it.
- **Block timestamps: the old constraint was obsolete, and has been acted on** (`0957f8c`, `c681b79`). `eth_getLogs` used to omit timestamps, so `alwaysFetchTimestamps` paid for an extra `eth_getBlockByHash` per block — the worst shape of cost under this ADR, since a browser provider frequently cannot batch those calls and each is its own round-trip. `blockTimestamp` is now on the log itself (`ethereum/execution-apis#639`, merged 2025-08-25), so the core reads it from the log and fetches only the blocks that arrived without one, with the fetched values cached across rounds so the re-scanned reorg window is not re-fetched. On a compliant node the timestamp axis now costs zero extra requests. It is not universal — Hardhat's EDR does not serve it as of hardhat 3.14.0 — so the fallback stays, and the field stays optional throughout.
