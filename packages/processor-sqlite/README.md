# @ethereum-indexer/processor-sqlite

An `EventProcessor` whose derived state is versioned rows in [`@ethereum-indexer/state-store-sqlite`](../state-store-sqlite) rather than an object in memory. Indexing a chain normally leaves the state readable **as of any earlier block**, on the hash, height or time axis, without the processor author doing anything beyond declaring entities and writing handlers.

```ts
import {VersionedStateEventProcessor} from '@ethereum-indexer/processor-sqlite';

const processor = new VersionedStateEventProcessor(db, {
	version: '1.0.0',
	entities: [{name: 'token', id: ['id'], fields: {owner: 'text'}}],
	async onTransfer(state, event) {
		state.set('token', {id: event.args.id.toString()}, {owner: event.args.to});
	},
});

// driven by the core indexer, exactly like any other EventProcessor
const view = await processor.process(eventStream, lastSync);
await view.getAsOf('token', {id: '1'}, {hash: '0x...'}); // state as it was at that block
```

## What is different from the in-memory path

`ethereum-indexer-js-processor` reverts a reorg with immer reverse-patches, because reverting by replay needs the state as of the fork block and the in-browser path cannot get it. ADR-0001 records that and names the condition for revisiting it: a store that can answer "state as of block N". This is that store. Reverting here is a single `revertTo(forkPoint)`, two SQL moves per table over the validity ranges, with no patch history and no replay.

The observable behaviour is meant to be identical, and that is checked rather than claimed. `test/reorg.test.ts` runs the same scenarios as the in-memory package's characterization tests, and `test/equivalence.test.ts` runs both processors over the same streams and compares the resulting states directly, so divergence is a test failure rather than a discovery in production.

## Two things worth knowing before you wire it up

**Timestamps usually cost nothing, but check your node.** `blockTimestamp` is on the log itself under `execution-apis#639`, served by geth (>= 1.16.0), reth, besu, erigon and anvil, so the time axis is populated with no extra request. **Hardhat's EDR does not emit it** (verified on hardhat 3.14.0 / edr 0.3.8), and there set `stream: {alwaysFetchTimestamps: true}` so the core fetches the blocks whose logs lack one. That flag is now a fallback rather than a requirement: it only fetches what is actually missing, so leaving it on costs nothing on a compliant node. A block is never recorded without a real timestamp: `process` throws instead of guessing, because `getAsOf({timestamp})` has no way to tell a caller it was lied to.

**A handler's `set` writes the whole row.** A version is a complete row rather than a delta, mirroring the store's close-then-insert, so unlisted declared fields become `NULL`. To change one field, `get` the record and spread it; `get` is read-your-writes within the block being processed.

## What `process` returns

A `VersionedStateView`: a read-only query handle, not the state. Materialising a versioned store into an object would defeat its purpose, and the core never inspects the value anyway (it forwards the outcome of `process` and the `state` from `load` to the optional `onStateUpdated` callback and nothing else). The handle is read-only on purpose: handing back the store itself would put `applyBlock` and `revertTo` in reach of a UI callback. The processor is the only writer.

## Design notes

- ADR-0016 for the package name, ADR-0014 for the scope.
- ADR-0001 for why the in-memory path uses reverse-patches and what justified revisiting it here.
- ADR-0015 for why an unresolvable block address throws instead of answering `undefined`.
- `docs/design/historical-state-database.md` §2 and §5 for the versioned-row model and the revert.
- `src/sync.ts` for why the sync cursor lives in this package, and why it is one row.
