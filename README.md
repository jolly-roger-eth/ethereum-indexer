# ethereum-indexer

A modular indexer system for [ethereum](https://ethereum.org) and other blockchain following the same [RPC standard](https://ethereum.org/en/developers/docs/apis/json-rpc/).

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
