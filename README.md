# ethereum-indexer

A modular indexer system for [ethereum](https://ethereum.org) and other blockchain following the same [RPC standard](https://ethereum.org/en/developers/docs/apis/json-rpc/).

Main features:

- written in typescript, run both in-browser and on Node
- modular : you can use the part you want
- designed to run in-browser and uses [EIP-1193](https://eips.ethereum.org/EIPS/eip-1193) only in that context
- provide different Database design to store the indexer, but you can use your own.
- A json object can be used as DB (useful for in-browser indexing).
- Supports Reorg 
- Supports caching
