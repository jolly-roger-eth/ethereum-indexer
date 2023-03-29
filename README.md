# ethereum-indexer

![Indexing Anywhere](media/images/datastream.png)

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
