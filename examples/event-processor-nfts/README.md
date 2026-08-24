# event-processor-nfts

Who owns which token in an ERC-721 collection, written as an etherfold processor, and a browser app that indexes it in a tab.

## Run it

```sh
pnpm --filter event-processor-nfts browser
```

That is the whole command. It starts a Vite dev server and prints a `http://localhost:5173/` URL; open it. There is no server to run, no database to provision and no API key: the tab talks to a JSON-RPC node itself.

## What you should see

Within a few seconds:

- **Indexing** — `0xbc4c…f13d on chain 1, from block <n>`. That is Bored Ape Yacht Club on Ethereum mainnet, starting 2,000 blocks behind the tip.
- **State lives in** — `retention: unbounded, as-of reads: yes, survives a reload: yes`. This is the store's own capability report, read before anything is asked of it, not a claim this page makes.
- **Progress** — climbs to `block N / N (100%)` and then keeps pace with the chain.
- **Transfers seen** and **Current owners** — a handful of transfers over a 2,000-block window (BAYC moves a few times an hour), and the tokens whose owner this tab now knows.
- **This page load** — `indexed from the start block (<n>): no cursor was found`.

Now **reload the tab**. Everything is still there, and the last line changes to:

```
resumed: the first fetch of this page load asked for block 25825364, not 25823381
```

That is the point of the whole example. The rows and the sync cursor live in the same IndexedDB database and are written in the same transaction, so a reopened tab continues from where it stopped instead of re-indexing from the start block. Both runs would end on the same rows, which is why the page says which of the two happened: nothing in the state can tell you.

### Options

Appended to the URL as query parameters:

| parameter | default | |
| --- | --- | --- |
| `rpc` | `https://rpc.mevblocker.io` | any JSON-RPC endpoint. Public ones rate-limit and come and go; point this at your own node if the default is unhappy. With a wallet installed and no `?rpc=`, the page uses the wallet's provider instead. |
| `contract` | BAYC | any ERC-721 address on whatever chain the RPC serves |
| `blocks` | `2000` | how far behind the tip to start |

The start block is computed once and remembered in `localStorage`, because it is part of the indexing source and the source is hashed into the sync context: a start block that drifted with the chain tip would make every reload a different deployment and discard the state as stale.

## Choosing where the state lives

One line, in `browser/main.ts`:

```ts
const store = await createBrowserStateStore(NFTProcessor.entities, {
	databaseName: `etherfold-nfts-${chainId}-${CONTRACT}`,
});
```

Versioned rows in IndexedDB: the browser default, decided on measurement in [ADR-0024](../../docs/adr/0024-indexeddb-is-the-browser-default-until-four-things-are-true-at-once.md). Comment it out and uncomment the alternative directly below it:

```ts
const store = await createBrowserStateStore(NFTProcessor.entities, {
	backend: (entities) => new PatchStateStore(entities, {finalityDepth: 12}),
});
```

That is the light store: current state as a plain object, history as immer reverse patches. **The processor does not change** — not a handler, not a declaration, not an import. What changes is what the page then reports about itself:

```
State lives in   retention: revert-only, as-of reads: no, survives a reload: NO (memory-only, ADR-0023)
This page load   indexed from the start block (25823384): no cursor was found
```

The light store is memory-only by design ([ADR-0023](../../docs/adr/0023-the-patch-store-is-memory-only-and-refuses-a-revert-it-cannot-complete.md)), so a reload legitimately starts over. That is the trade, and an application reads it off `store.capabilities` at startup rather than discovering it from an empty tab.

## The two processors in `src/`

| file | authoring API | state |
| --- | --- | --- |
| `entities.ts` | `EntityProcessor` (`@etherfold/processor-entities`) | declared entities, written through a `MutationContext`, kept in whichever `StateStore` the deployment chose |
| `index.ts` | `JSProcessor` (`@etherfold/js-processor`) | one free-form object, mutated as an immer draft, persisted whole by a `KeepState` keeper |

`entities.ts` is what the browser app above runs, and it is the same object a server runs against SQLite: nothing in it names a backend.

`index.ts` is the original, kept because the free-form path is not deprecated and `examples/web-demo` consumes it. Having both is deliberate: this is the one place in the repository where the same indexing question is written in both styles, so the cost of porting between them is readable in a diff. They look almost identical on purpose — `on<EventName>(state, event, config)` either way — and only the writes differ.

## Building

```sh
pnpm --filter event-processor-nfts build          # the processors, to dist/
pnpm --filter event-processor-nfts browser:build  # the browser app, to dist/browser/
```
