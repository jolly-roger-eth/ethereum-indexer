# A `contractsData`-only processor module can never resolve a source

**2026-09-01**, noticed while wiring `index-to-a-store-from-the-cli`.

`resolveSource` (`packages/utils/src/processorSetup.ts`) only fetches `eth_chainId` when the module exports `contractsDataPerChain`, and then throws `no chainId found` whenever `chainIDAsDecimal` is unset — so a module exporting ONLY `contractsData` (which its own comment describes as the fallback, and which `examples/event-processor-nfts/src/index.ts` exports) always throws, on the CLI and on the server alike. Either the fallback should fetch the chain id too, or the message should say that `contractsDataPerChain` (or `-d`) is the only way to name a source from a module.
