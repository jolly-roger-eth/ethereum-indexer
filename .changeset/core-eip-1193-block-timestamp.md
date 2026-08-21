---
'ethereum-indexer': patch
---

Take `blockTimestamp` from `eip-1193`'s own type, dropping the local widening.

`eip-1193@0.6.6` adds the optional `blockTimestamp` to `EIP1193Log`, so the local intersection type that existed only because the upstream type predated `execution-apis#639` is gone, and the log is read as `IncludedEIP1193Log` directly. The dependency range moves to `^0.6.6`, since the source now relies on that field being declared rather than merely being on the wire.

No behaviour change. `parseLogBlockTimestamp` still takes `unknown` rather than `EIP1193QUANTITY`, deliberately: the spec (and therefore the type) says hex QUANTITY, while at least one client serves decimal. The type states the contract, the parser handles what actually arrives.
