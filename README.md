# ethereum-indexer

A modular indexer system for [ethereum](https://ethereum.org) and other blockchain following the same [RPC standard](https://ethereum.org/en/developers/docs/apis/json-rpc/).

You can find some demoes in the [examples folder](./examples/)

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

But for some use case it is actually possible and efficient. This is the case where the amount of event is bounded or its scale rate is limited s

It is for example possible to instead of indexing all ERC721, to simply index the ERC721 of the current account.

## What is ethereum-indexer

The ethereum-indexer library aims to be a complete and modular system to run ethereum indexer both in node and in browser.

It especially designed for the latter but modules are in the work to work in node.js + database context

## Main Goal:

The main goal of this library is to allow decentralised application that expect every user to provide their own JSON RPC enabled ethereum node to not require any backend services (or at max a event cache).

This is not designed to support every kind of indexing as the limitation of the in-browser enviroment limit some of the features expected by some indexing strategy.

An example of such impossibility is generic ERC-721 indexing that require a big amount of data and a big amount of extra request to fetch each token metadata uri.

Having said that, an in-browser indexing strategy for ERC721 can work in the context of a single user where the indexer would filter out all the token not belonging to the user in question.

## Caveats

Due to the limitation of EIP-1193 (no batch request) and the current JSON RPC spec (no timestamp available in eth_getLogs result (See +++)) the indexer processors are expected to not make use of these features.

Using these features would work in a server environment where results can be cached across load-balanced instanced, but in a browser environment where each user would have its own instance, these would slow down the indexing too much.

Having said that an hybrid approach is possible where a server index and the in-browser indexer exists only as a backup when every server instances are unavailable expect for a cache (which could even be shared across user in p2p manner).

It is also worth noting that for an indexer to work, it needs to index all events and depending on the games or applications, this might not fit in memory. For such case, there is not other option to have that handled by a remote service.
