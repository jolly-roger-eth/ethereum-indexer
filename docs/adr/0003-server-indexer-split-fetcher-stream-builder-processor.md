# The server-side indexer splits into log-fetcher, stream-builder and processor

The server-side indexer is three parts, not two: a **log-fetcher** that only talks to the chain (`eth_getLogs`) and holds no state, a **stream-builder** that owns reorg detection and the event stream, and the existing **`EventProcessor`**, which stays exactly what it is today: a dumb reducer that is fed a stream. The fetcher is its own deployable; the stream-builder and the processor are hosted together in the **indexer-server**. We chose this so that reorg logic exists in exactly one place, and so that the processor contract in `packages/ethereum-indexer` needs no change at all.

This **reverses** the intent recorded in `work/specs/tasked/historical-state-database.md`, which put both the fetching and the stream (including `removed` markers and unconfirmed-block tracking) on the watcher side of the wire, leaving the processor to store only derived state.

## Considered Options

- **Fetcher owns the stream (the original intent).** The watcher tracks the unconfirmed window, emits `removed` markers and pushes a finished stream. Rejected because it makes the chain-facing component stateful, puts reorg logic on the side of the wire that holds no state, and means a processor-logic rebuild must re-fetch the whole stream across the wire.
- **Fetcher and stream-builder split (chosen).** The fetcher becomes pure and disposable, so it can be restarted, replaced or run redundantly without any recovery procedure. The stream lands next to the state that is derived from it.

## Consequences

- The word **processor** stays reserved for the existing reducer (`EventProcessor`, `JSObjectEventProcessor`). The new server-side responsibilities belong to the stream-builder, so no existing code has to be renamed or reinterpreted.
- Re-processing after a processor upgrade becomes a **local sequential scan** of the stream the indexer-server already holds, rather than a re-fetch from the chain or across the wire. See ADR-0008.
- The indexer-server now stores two things (the stream and the versioned state) where the spec assumed one. That growth in storage is the price paid for the reduction in responsibilities elsewhere. See ADR-0006.
- The chain is still the ultimate source of truth: losing the stored stream is recoverable by re-fetching from genesis, expensively.
