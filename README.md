![Indexing Anywhere](https://raw.githubusercontent.com/wighawag/etherfold/main/preview-grey.png)

A modular indexer system for [ethereum](https://ethereum.org) and other blockchain following the same [RPC standard](https://ethereum.org/en/developers/docs/apis/json-rpc/).

Git Repo: https://github.com/wighawag/etherfold

You can find some demoes in the <a href="https://wighawag.github.io/etherfold/examples/#home" target="_blank">examples folder</a>

And here is the [Documentation Website](https://wighawag.github.io/etherfold/)

## See it index, in one command

```sh
pnpm --filter event-processor-nfts browser
```

Opens a tab that indexes an ERC-721 collection off a real chain, with no server and no database to provision: one processor, its state in IndexedDB, and a reload that CONTINUES from its cursor instead of starting again. [`examples/event-processor-nfts`](https://github.com/wighawag/etherfold/blob/main/examples/event-processor-nfts/README.md) says what to expect and how to swap the storage backend in one line.

The same processor file, on a server, into SQLite — not a port of it, the file itself:

```sh
pnpm --filter event-processor-nfts build
NFT_CONTRACT=0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d NFT_START_BLOCK=21000000 \
  pnpm --filter event-processor-nfts index -n https://rpc.mevblocker.io
```

`etherfold index --store sqlite --db <libsql url>` runs the processor into versioned rows and exits at the tip. There is ONE way to author a processor (ADR-0037), so the module hands over the processor itself and the operator names only where the state goes.

## Main features:

- written in typescript, run both in a browser context and node
- modular : you can use the part you want
- designed to run in-browser and relies only on [EIP-1193](https://eips.ethereum.org/EIPS/eip-1193)
- one processor, several storage backends behind one seam: SQLite on a server, versioned rows in IndexedDB in a tab, or a light patch store
- as-of reads and an explicit retention window, so a historical question gets an answer or a refusal and never a tip read
- Supports Reorg
- Supports caching

## Why ?

The main reason for building `etherfold` is to have the indexing be performed in a fully decentralised manner: in the client.

This obviously does not scale for all use-case: try indexing all ERC20/ERC721 and the amount of log to fetch is too big to be useful, in a browser context.

But for some use case it is actually possible and efficient. This is the case where the amount of event is bounded or its scale rate is limited.

It is for example possible to instead of indexing all ERC721, to simply index the ERC721 of the current account.

## Caveats

Due to the limitation of EIP-1193 (no batch request), anything that needs an extra request per block or per transaction is expensive in the browser, so indexer processors are expected to not make use of such features.

Using them would work in a server environment where results can be cached across load-balanced instances, but in a browser environment where each user would have its own instance, they would slow down the indexing too much.

**Block timestamps are no longer one of those features.** `blockTimestamp` is now part of the log object itself, standardised in [`ethereum/execution-apis#639`](https://github.com/ethereum/execution-apis/pull/639) and served by go-ethereum (>= 1.16.0), reth, besu, erigon, anvil and ethereumjs, so a processor can read `event.blockTimestamp` for free. It is not universal — Hardhat's EDR does not emit it as of hardhat 3.14.0 ([edr#1643](https://github.com/NomicFoundation/edr/issues/1643)) — so the field stays optional, and `stream.alwaysFetchTimestamps` remains as the fallback: it now fetches only the blocks whose logs arrived without one, and costs nothing on a node that supplies them.

Having said that an hybrid approach is possible where a server index and the in-browser indexer exists only as a backup when every server instances are unavailable expect for a cache (which could even be shared across user in p2p manner).

It is also worth noting that for an indexer to work, it needs to index all events and depending on the games or applications, this might not fit in memory or in browser storage qutoa. For such case, there is no other option to have that handled by a remote service.

## Usage

install `@etherfold/browser` and `@etherfold/processor-entities`

```
npm i @etherfold/browser @etherfold/processor-entities
```

A processor is **entity declarations plus one handler per event**, and it names no backend: the same object indexes into IndexedDB in a tab and into SQLite on a server. Here is one, for a contract that emits `MessageChanged(address user, string message)`:

```ts
import type {EntityProcessor} from '@etherfold/processor-entities';

const abi = [
	{
		anonymous: false,
		inputs: [
			{indexed: true, name: 'user', type: 'address'},
			{indexed: false, name: 'message', type: 'string'},
		],
		name: 'MessageChanged',
		type: 'event',
	},
] as const;

export const greetings: EntityProcessor<typeof abi> = {
	// REQUIRED, and ideally generated so it changes whenever a handler does. The indexer
	// discards state computed by a previous version by comparing it; if you edit a handler
	// and forget to bump it, the indexer says so at load time (an error-level drift report,
	// plus the `onProcessorDrift` callback). Set `strictProcessorDrift: true` in the indexer
	// config to refuse to start instead of merely reporting.
	version: '1.0.1',

	// `{name, id, fields}` per entity is the whole schema an author writes: the store owns
	// the layout, the version columns, the as-of read and the reorg revert.
	entities: [{name: 'greeting', id: ['user'], fields: {message: 'text'}}],

	// one handler per event, over a MutationContext with read-your-writes inside the block
	async onMessageChanged(state, event) {
		state.set('greeting', {user: event.args.user.toLowerCase()}, {message: event.args.message});
	},
};
```

Indexing it in a browser tab is two more lines. The first names WHERE the state lives, which is the only deployment decision here; the second wires the hook:

```ts
import {createBrowserStateStore, createIndexerState} from '@etherfold/browser';
import {fromEntityProcessor} from '@etherfold/processor-entities';

// versioned rows in IndexedDB: the browser default, decided on measurement (ADR-0024)
const store = await createBrowserStateStore(greetings.entities, {databaseName: 'greetings'});
const indexer = createIndexerState(fromEntityProcessor(greetings)(store));

await indexer.init({
	provider: (window as any).ethereum,
	source: {chainId: '11155111', contracts: [{abi, address: '0x21d3…', startBlock: 3040661}]},
});

// index on a timer; `indexMore` / `indexMoreAndCatchupIfNeeded` are the manual forms, and
// calling one on every `newHeads` subscription message is better than a timer
await indexer.startAutoIndexing();

// `indexer.state` publishes a READ HANDLE, because the state is rows in a store rather than
// an object: ask it questions instead of being handed all of it
indexer.state.subscribe(async (view) => {
	const mine = await view.getCurrent<{message: string}>('greeting', {user: account});
	render(mine?.message);
});

// and `indexer.syncing` publishes the cursor and the progress
indexer.syncing.subscribe(($syncing) => showProgress($syncing.lastSync?.syncPercentage ?? 0));
```

`.withHooks(react)` turns those observables into React hooks (`useState`, `useSyncing`, `useStatus`).

A runnable version of all of this, against a real chain, is [`examples/event-processor-nfts`](https://github.com/wighawag/etherfold/blob/main/examples/event-processor-nfts/README.md); [`examples/browser-reference`](https://github.com/wighawag/etherfold/blob/main/examples/browser-reference) is the minimal wiring with both hot-reload axes.
