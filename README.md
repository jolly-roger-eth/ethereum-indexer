# ethereum-indexer

![Indexing Anywhere](media/images/preview.jpg)

A modular indexer system for [ethereum](https://ethereum.org) and other blockchain following the same [RPC standard](https://ethereum.org/en/developers/docs/apis/json-rpc/).

You can find some demoes in the [examples folder](./examples/)

And here is the [Documentation Website](https://jolly-roger-eth.github.io/ethereum-indexer/)

## Main features:

- written in typescript, run both in a browser context and node
- modular : you can use the part you want
- designed to run in-browser and relies only on [EIP-1193](https://eips.ethereum.org/EIPS/eip-1193)
- when run on a server, you can hook your own database module to store the indexer process's result
- A json object can be used as DB (useful for in-browser indexing).
- Supports Reorg
- Supports caching

## Why ?

The main reason for building `ethereum-indexer` is to have the indexing be performed in a fully decentralised manner: in the client.

This obviously does not scale for all use-case: try indexing all ERC20/ERC721 and the amount of log to fetch is too big to be useful, in a browser context.

But for some use case it is actually possible and efficient. This is the case where the amount of event is bounded or its scale rate is limited.

It is for example possible to instead of indexing all ERC721, to simply index the ERC721 of the current account.

## Caveats

Due to the limitation of EIP-1193 (no batch request) and the current JSON RPC spec (no timestamp available in eth_getLogs result (See [improvement proposal's discussion](https://ethereum-magicians.org/t/proposal-for-adding-blocktimestamp-to-logs-object-returned-by-eth-getlogs-and-related-requests/11183))) the indexer processors are expected to not make use of these features.

Using these features would work in a server environment where results can be cached across load-balanced instanced, but in a browser environment where each user would have its own instance, these would slow down the indexing too much.

Having said that an hybrid approach is possible where a server index and the in-browser indexer exists only as a backup when every server instances are unavailable expect for a cache (which could even be shared across user in p2p manner).

It is also worth noting that for an indexer to work, it needs to index all events and depending on the games or applications, this might not fit in memory or in browser storage qutoa. For such case, there is no other option to have that handled by a remote service.

## Usage

install `ethereum-indexer-browser`

```
npm i ethereum-indexer-browser
```

If you use react, here is a mostly self-contained example from [App.tsx](https://github.com/jolly-roger-eth/ethereum-indexer/blob/main/examples/basic/src/App.tsx)

```tsx
import "./App.css";
import { fromJSProcessor, JSProcessor } from "ethereum-indexer-js-processor";
import {
  createIndexerState,
  keepStateOnIndexedDB,
} from "ethereum-indexer-browser";
import { connect } from "./utils/web3";
import react from "react";

// we need the contract info
// the abi will be used by the processor to have its type generated, allowing you to get type-safety
// the adress will be given to the indexer, so it index only this contract
// the startBlock field allow to tell the indexer to start indexing from that point only
// here it is the block at which the contract was deployed
const contract = {
  abi: [
    {
      anonymous: false,
      inputs: [
        {
          indexed: true,
          name: "user",
          type: "address",
        },
        {
          indexed: false,
          name: "message",
          type: "string",
        },
      ],
      name: "MessageChanged",
      type: "event",
    },
  ],
  address: "0x21d366ee3BbF67AB057c517380D37E54fFd9dfC0",
  startBlock: 3040661,
} as const;

// we define the type of the state computed by the processor
// we can also declare it inline in the generic type of JSProcessor
type State = { greetings: { account: `0x${string}`; message: string }[] };

// the processor is given the type of the ABI as Generic type to get generated
// it also specify the type which represent the current state
const processor: JSProcessor<typeof contract.abi, State> = {
  // you can set a version, ideally you would generate it so that it changes for each change
  // when a version changes, the indexer will detect that and clear the state
  // if it has the event stream cached, it will repopulate the state automatically
  version: "1.0.1",
  // this function set the starting state
  // this allow the app to always have access to a state, no undefined needed
  construct() {
    return { greetings: [] };
  },
  // each event has an associated on<EventName> function which is given both the current state and the typed event
  // each event's argument can be accessed via the `args` field
  // it then modify the state as it wishes
  // behind the scene, the JSProcessor will handle reorg by reverting and applying new events automatically
  onMessageChanged(state, event) {
    const greetingFound = state.greetings.find(
      (v) => v.account === event.args.user
    );
    if (greetingFound) {
      greetingFound.message = event.args.message;
    } else {
      state.greetings.push({
        message: event.args.message,
        account: event.args.user,
      });
    }
  },
};

// we setup the indexer via a call to `createIndexerState`
// this setup a set of observable (subscribe pattern)
// including one for the current state (computed by the processor above)
// and one for the syncing
// we then call `.withHooks(react)` to transform these observable in react hooks ready to be used.
const { init, useState, useSyncing, startAutoIndexing } = createIndexerState(
  fromJSProcessor(processor)(),
  {
    keepState: keepStateOnIndexedDB("basic") as any,
  }
).withHooks(react);

// we now need to get a handle on a ethereum provider
// for this app we are simply using window.ethereum
const ethereum = (window as any).ethereum;

// but to not trigger a metamask popup right away we wrap that in a function to be called via a click of a button
function start() {
  if (ethereum) {
    // here we first connect it to the chain of our choice and then initialise the indexer
    // see ./utils/web3
    connect(ethereum, {
      chain: {
        chainId: "11155111",
        chainName: "Sepolia",
        rpcUrls: ["https://rpc.sepolia.org"],
        nativeCurrency: { name: "Sepolia Ether", symbol: "SEP", decimals: 18 },
        blockExplorerUrls: ["https://sepolia.etherscan.io"],
      },
    }).then(({ ethereum }) => {
      // we already setup the processor
      // now we need to initialise the indexer with
      // - an EIP-1193 provider (window.ethereum here)
      // - source config which includes the chainId and the list of contracts (abi,address. startBlock)
      init({
        provider: ethereum,
        source: { chainId: "11155111", contracts: [contract] },
      }).then(() => {
        // this automatically index on a timer
        // alternatively you can call `indexMore` or `indexMoreAndCatchupIfNeeded`, both available from the return value of `createIndexerState`
        // startAutoIndexing is easier but manually calling `indexMore` or `indexMoreAndCatchupIfNeeded` is better
        // this is because you can call them for every `newHeads` eth_subscribe message
        startAutoIndexing();
      });
    });
  }
}

function App() {
  // we use the hooks to get the latest state and make sure react update the values as they changes
  const $state = useState();
  const $syncing = useSyncing();

  if (!ethereum) {
    return (
      <div className="App">
        <h1>Indexing a basic example</h1>
        <p>To test this app, you need to have a ethereum wallet installed</p>
      </div>
    );
  }
  // we have various variable to check the status of the indexer
  // here we can act on whether the indexer is still waiting to be provided an EIP-1193 provider
  if ($syncing.waitingForProvider) {
    return (
      <div className="App">
        <h1>Indexing a basic example</h1>
        <button
          onClick={start}
          style={{ backgroundColor: "#45ffbb", color: "black" }}
        >
          Start
        </button>
      </div>
    );
  }

  // here we add a progress bar indicating the progress of the indexer
  return (
    <div className="App">
      <h1>Indexing a basic example</h1>
      <p>{$syncing.lastSync?.syncPercentage || 0}</p>
      {$syncing.lastSync ? (
        <progress
          value={($syncing.lastSync.syncPercentage || 0) / 100}
          style={{ width: "100%" }}
        />
      ) : (
        <p>Please wait...</p>
      )}
      <div>
        {$state.greetings.map((greeting) => (
          <p key={greeting.account}>{greeting.message}</p>
        ))}
      </div>
    </div>
  );
}

export default App;
```
