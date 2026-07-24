# In-browser EIP-1193 indexing is the primary design axis

The indexer is designed so an indexer can run **client-side, in the browser**, over a plain EIP-1193 provider — for **decentralization** (each client can index for itself, no trusted server required). This shapes the whole processor contract and is a deliberate constraint, not an accident of the code.

## Consequences

- The core stays EIP-1193-first and must not require a server to function.
- **Batch RPC IS allowed** (`providerSupportsETHBatch`) — an earlier framing that batch was off-limits is inaccurate; batch is used where the provider supports it.
- **Block timestamps: the old constraint is now obsolete.** The README documents that `eth_getLogs` does not return timestamps (hence `alwaysFetchTimestamps` needing an extra fetch). Modern Ethereum nodes now include `blockTimestamp` directly in log results (standardized into the execution-apis spec), so this can be brought in to avoid the extra round-trip. This is drift between the documented constraint and current reality — see the follow-up idea in `work/notes/ideas/`.
