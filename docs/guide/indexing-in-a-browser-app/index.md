# Indexing in a browser app

The shape a template wires once and every app on it inherits: **one contract, one processor, EIP-1193 from the user's own wallet, IndexedDB for the state, results consumed as stores** — and a development loop where both the contract and the processor get replaced while the tab is still open.

The reference implementation is [`examples/browser-reference/browser/main.ts`](https://github.com/wighawag/etherfold/blob/main/examples/browser-reference/browser/main.ts). It is one file, meant to be read top to bottom in one sitting and copied. This page is what you should know before you copy it.

Two things about that file are deliberate and worth stating, because they are the reason to trust it over a snippet in a document: it is **typechecked by the acceptance gate**, and every claim it makes is **asserted against a real browser** by [`verify/reference.spec.ts`](https://github.com/wighawag/etherfold/blob/main/examples/browser-reference/verify/reference.spec.ts), which needs no network — the wallet and the chain are injected into the page. Run it with `pnpm --filter browser-reference verify:browser`. See [ADR-0030](../../adr/0030-every-workspace-directory-is-typechecked-browser-execution-is-not-a-gate.md) for why that split exists.

## Two hazards that do not look like hazards

### Ask the connection for the chain, never the provider

`@etherplay/connect`'s `connection.provider` is an always-on wrapper: it routes through the chosen wallet when there is one and falls back to the chain's own endpoint when there is not, so your app has one provider either way. It is **pinned to the `chainInfo` it was constructed with**, so:

```ts
await connection.provider.request({method: 'eth_chainId'}); // ALWAYS your app's chain id
```

A chain check written against it compares a constant with itself. It passes for a wallet sitting on Polygon, and the app then indexes a mainnet address against a Polygon node — finding nothing, and looking merely slow. That bug shipped in this repository, reviewed and built green.

```ts
// ✗ never: pinned, answers your own chainInfo whatever the wallet is set to
const chainId = await connection.provider.request({method: 'eth_chainId'});

// ✓ always: the connection state reports the WALLET's own chain
const chainId = $connection.wallet?.chainId;
```

The provider is for reads (`eth_getLogs`, `eth_blockNumber`). It is not an authority on what the wallet is pointed at.

### Wire first, subscribe last

A store subscription **fires synchronously with the current value**, before `subscribe()` returns. So a callback that touches anything declared after the `subscribe` call reads it in the temporal dead zone and throws.

```ts
// ✗ throws `Cannot access 'unsubscribe' before initialization`
//   on every path where the store has ALREADY settled
const unsubscribe = connection.subscribe(($c) => {
	if (settled($c)) unsubscribe();
});

// ✓ declare with let, initialise to a no-op, defer the call
let unsubscribe: () => void = () => {};
const stop = () => setTimeout(() => unsubscribe(), 0);
unsubscribe = connection.subscribe(($c) => {
	if (settled($c)) stop();
});
```

The reason this survives testing is that the paths a human *clicks* — a wallet picker, an accounts prompt — resolve asynchronously and work fine. The paths that break are the already-settled ones: a single auto-selected wallet, a chain mismatch, no wallet at all. That is the returning user, not the first-time one.

The same trap is not limited to the `unsubscribe` handle. Attach `indexer.syncing.subscribe(...)` and `indexer.state.subscribe(...)` at the **end** of your setup, after everything they close over exists. While writing the reference, those two calls sat above the pending-transaction map they read, and the page died on load. It typechecked perfectly; the browser run caught it.

## Telling whether the state already accounts for your transaction

Before an app lays an **optimistic update** over indexed state, it has to know whether the indexed state already contains the transaction's effects — because applied on top of a state that already has it, a non-idempotent update (a counter, a balance, an append) is counted twice.

```ts
const verdicts = indexer.checkTxInclusion([{txHash, minedAtBlock}]);
if (verdicts[txHash].status === 'included') dropOverlay(txHash); // else KEEP it
```

Your own **receipt cannot answer this**. A block height is a local opinion about a chain rather than an identity, and the receipt's block *hash* is the wrong identity: a reorg can re-include the same transaction in a different block, so comparing hashes reports "not indexed" for a transaction that *is* indexed — producing exactly the double count the check exists to prevent. The question is about the indexer's own chain, so only the indexer answers it.

Three statuses, not two. `'unknown'` is a real answer and collapsing it is what makes a wrong UI: treated as `'included'` it double-counts, treated as `'absent'` the effect briefly vanishes. Keep the overlay on anything that is not `'included'`.

**The pairing with `state` is safe in one direction.** Within one update the hook sets `syncing` before `state`, so the cursor can be one statement ahead of the rows and never behind. An overlay dropped a moment early flickers; one dropped late is counted twice. A subscriber that reads both after an update sees them agree.

Two documented limits, both following from the unconfirmed window being *sparse* (event-bearing blocks only): a transaction that emitted no indexed event can never hit, and `'absent'` means "not in the window", so do not ask about a transaction older than it. Pass `minedAtBlock` when you have a receipt to close both.

## Hot reload: two independent axes

A template with hot contract replacement has **two** things that get replaced while the tab runs, and they fail differently.

### Axis one — the processor was edited

`updateProcessor` decides whether your state survives by comparing **version hashes**, and a version hash is `${version}-${hash({entities, config})}`. **Handler code is in none of that.**

So editing a reducer and leaving `version` alone is not a change the core can see: the swap is **skipped**, the old processor object keeps running, and your edit never executes. The only complaint is a `named-logs` warning most apps never route anywhere.

```ts
const outcome = await indexer.updateProcessor({kind: 'entities', processor: next});
outcome.stateDiscarded; // false => the swap was SKIPPED, your edit is not running
```

Make the edit land by bumping `version` in the processor, or by passing `{force: true}`. Both cost the same thing: the state is discarded and rebuilt from the start block, because the core cannot know which part of the state your edit invalidated, and "all of it" is the only answer that cannot be wrong.

Generating the version (a content hash, a build id, a git sha) is the way to stop relying on memory.

### Axis two — the contract was redeployed

On a local chain these apps deploy behind a **proxy**, so a redeploy does not move the address. What moves is the implementation and therefore the generated ABI — and the ABI is hashed into the indexing source, so handing the new source over is enough:

```ts
const outcome = await indexer.updateIndexer({source: {chainId, contracts: [next]}});
```

`reset()` is **not** also required; calling it would be a second full rebuild.

If the ABI did *not* change, nothing is discarded — and that is correct rather than a gap. The same signatures over the same address still mean what the indexed rows say they mean.

The case that looks like it needs a third branch — an implementation that changed what its events *mean* while keeping their signatures — does not, because it cannot happen without a **processor** change. New meaning has to be implemented by new handler code, and writing that is the developer's job. So it travels axis one: bump `version`, and the swap discards and re-indexes.

| what changed | the response |
| --- | --- |
| ABI changed, same address | `updateIndexer({source})` — discards and re-indexes |
| event *meaning* changed | edit the processor and bump `version` — axis one |
| genesis hash changed (a different chain) | reload the page |

That last row is why a template's deployments store forces `location.reload()` only on a genesis change: a different chain invalidates the provider, the cursor and the store at once, and no in-place reconfigure covers that. Everything else takes the reactive path.

### An upgrade that only adds events needs no feature

Worth knowing before you go looking for one. Decoding is by topic0 against the ABI you supply, so an upgraded implementation that emits a **new** event is indexed from block 0 simply by giving the source the union of both ABIs. Two entries at the same address also work, and merge:

```ts
contracts: [
	{abi: [Transfer], address: X, startBlock: 0},
	{abi: [Transfer, Approval], address: X, startBlock: 500},
]
// -> events indexed at that address: Transfer, Approval
```

Adding the event does move the source hash, so it costs one re-index. That is the conservative default and it is correct: the indexer cannot know whether that event could already have been emitted in the blocks it has, and if it could, those logs were never fetched, because the topic was not in the filter.

The current limit is an upgrade that **changes an existing event's signature**. Two events sharing a name but not their inputs are refused today, even though their topic0s differ. Tracked in `work/specs/ready/an-upgraded-contract-is-indexable-from-its-first-block.md`.

### The one thing a rebuild does not do for you

A discard replays the **whole** history, including the blocks the previous implementation wrote. So a handler that merely implements the new meaning silently reinterprets pre-upgrade events under post-upgrade rules.

The upgrade block is your own knowledge, and spending it is ordinary handler code — `event.blockNumber` is on every event:

```ts
async onTransfer(state, event) {
	const weight = event.blockNumber >= UPGRADE_BLOCK ? next : previous;
	// ...
}
```

A local chain restarted with each deploy never meets this. A chain that keeps its history always does.

### Both axes report what they did

`updateProcessor`, `updateIndexer` and `reset` return `{stateDiscarded: boolean}`. Branch on it rather than re-deriving the rule — the rule includes `force`, the entity declarations and the source hashes, and a caller who gets that derivation wrong fails silently.

Use it to tell the user their data is being rebuilt. You do **not** need it to clear your own copy of the state: the hook re-seeds its `state` store at the moment of a discard, so subscribers never see state the core has thrown away.
