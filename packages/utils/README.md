# @etherfold/utils

The Node-side glue between a **processor module on disk** and the runtime that drives it: load the module, get the processor out of it, and work out which contracts it is meant to index.

This is host code, not engine code. It reads the filesystem (`node:fs`, `node:module`), so it belongs to a CLI or a server and not to a browser bundle.

## When you want this package

You are writing a HOST that takes a processor path from an operator: `-p ./dist/processor.js`, an environment variable, a job definition. [`etherfold`](https://github.com/wighawag/etherfold/tree/main/packages/cli) is built on it. If your processor is `import`ed by name in your own source, you do not need any of this: hand the object to [`@etherfold/processor-entities`](https://github.com/wighawag/etherfold/tree/main/packages/processor-entities) directly.

## Loading a processor

```ts
import {resolveProcessorAndSource} from '@etherfold/utils';
import type {EntityProcessor} from '@etherfold/processor-entities';

const {processor, source} = await resolveProcessorAndSource<Abi, unknown, EntityProcessor<Abi>>({
	processorPath: './dist/processor.js',
	provider, // used only to ask `eth_chainId`, and only when the module keys contracts per chain
});
```

That is the three steps composed. They are also separately available, because a host that already knows its source only wants the first two:

- **`loadProcessorModule(path, {cwd, importModule, requireResolve})`** imports the module. An absolute path is imported as-is; a relative one is joined against `cwd` and, failing that, resolved through `createRequire(cwd/node_modules)` so a bare package specifier still works.
- **`instantiateProcessor(module, {processorPath, processorConfig})`** calls the module's `createProcessor` (or uses it as-is when it is already an object) and hands back **what it made, unread**: the AUTHORING object, declarations plus handlers. It deliberately does NOT build a runtime, because that would mean picking a store, and where the state lives is the HOST's decision -- which is exactly what lets one processor file run in a tab and on a server. The caller supplies the type it expects; a module still returning the retired `{kind, processor}` tag is REFUSED by name (ADR-0037) rather than unwrapped.
- **`resolveSource(module, provider)`** reads `contractsDataPerChain[chainId]` (fetching `eth_chainId` only when that field exists) and falls back to `contractsData`.

## Loading contracts from a deployments folder

For the `-d ./deployments/sepolia` case, where the ABIs and addresses are build artifacts rather than something the processor module carries:

```ts
import {loadContracts} from '@etherfold/utils';

const source = loadContracts('./deployments/sepolia'); // an IndexingSource
```

It takes a folder or a single file in hardhat-deploy / rocketh format: every `*.json` with an `address` becomes a contract, `.chainId` or `.chain` supplies the chain id (and the genesis hash), two artifacts at one address are merged with the LOWEST `startBlock`, and a missing or non-numeric chain id is refused.

`filterOutFieldsFromObject`, `filterOutUnderscoreFieldsFromObject`, `clean` and `removeUndefinedValuesFromObject` are the small object helpers that live here beside them.

## Related

[`@etherfold/core`](https://github.com/wighawag/etherfold/tree/main/packages/core) for the `IndexingSource` these functions produce, [`@etherfold/processor-entities`](https://github.com/wighawag/etherfold/tree/main/packages/processor-entities) for what a processor module should export, and [`etherfold`](https://github.com/wighawag/etherfold/tree/main/packages/cli) for a host that wires all of it together.

## Tests

`pnpm --filter @etherfold/utils test`, vitest.
