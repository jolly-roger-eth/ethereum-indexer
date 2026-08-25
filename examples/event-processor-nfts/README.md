# event-processor-nfts

Which NFTs an account owns, written as an etherfold processor, and a browser app that indexes it in a tab — reading the chain through the user's own wallet.

## Run it

```sh
pnpm --filter event-processor-nfts browser
```

That is the whole command. It starts a Vite dev server and prints a `http://localhost:5173/` URL; open it. There is no server to run, no database to provision and no API key.

With a browser wallet installed it indexes **your** NFTs, reading through your wallet's node. With no wallet, or to look at someone else's tokens, name an account:

```
http://localhost:5173/?account=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045&via=endpoint
```

## What you should see

- **Indexing** — `NFTs of 0x… on chain 1, from block <n>`.
- **Reading through** — the wallet you picked, or the public endpoint. This is the line that says whether the demo is decentralised or merely convenient.
- **State lives in** — `retention: unbounded, as-of reads: yes, survives a reload: yes`. The store's own capability report, read before anything is asked of it.
- **Progress** — climbs to `block N / N (100%)` and then keeps pace with the chain.
- **Same-signature ERC-20 logs** — see below. On a 40,000-block window over vitalik.eth this reads `41 log(s) … refused`, against **one** genuine NFT transfer.
- **This page load** — `indexed from the start block (<n>): no cursor was found`.

Now **reload the tab**. Everything is still there, and the last line changes to:

```
resumed: the first fetch of this page load asked for block 25831271, not 25791283
```

That is the point of the whole example. The rows and the sync cursor live in the same IndexedDB database and are written in the same transaction, so a reopened tab continues instead of re-indexing. Both runs end on the same rows, which is why the page says which of the two happened: nothing in the state can tell you.

### Options

| parameter | default | |
| --- | --- | --- |
| `account` | your connected account | whose tokens to index. Given, no connect prompt appears — see below |
| `via` | `wallet` | `endpoint` reads through `rpc` instead of the wallet |
| `rpc` | `https://rpc.mevblocker.io` | the endpoint used when `via=endpoint`, or when no wallet is present |
| `blocks` | `20000` | how far behind the tip to start |

The start block is computed once and remembered in `localStorage`, because it is part of the indexing source and the source is hashed into the sync context: a start block that drifted with the chain tip would make every reload a different deployment and discard the state as stale.

## Two wallet target steps, and why both are here

How much of the wallet is needed depends on whose tokens are being indexed:

- **`?account=` given** — the address is already known, so nothing about your accounts is needed. The wallet is only a **node**. That is `targetStep: 'WalletChosen'` with `selectWallet()`, which picks a wallet over EIP-6963 and routes reads through it **without ever calling `eth_requestAccounts`**. No permission popup to read a public chain.
- **no `?account=`** — the address *is* yours, so the accounts must be requested: `targetStep: 'WalletConnected'` with `connect()`.

Asking for accounts in the first case would be permission theatre. Wallet discovery is [`@etherplay/connect`](https://www.npmjs.com/package/@etherplay/connect)'s job, not this example's and not `@etherfold/browser`'s — an indexing package takes an EIP-1193 provider and stays out of wallet UX.

**`via=wallet` has a cost, and the page shows it.** Reading through an extension that relays (Coinbase Wallet talks to `wss://www.walletlink.org/rpc` even as an extension) turns a few thousand `eth_getLogs` into a crawl. `?via=endpoint` is the escape hatch, and which one served the reads is on screen rather than guessed at.

## The ERC-20 collision, which is the interesting part

`Transfer(address,address,uint256)` hashes to the **same `topic0`** for ERC-20 and ERC-721. Indexing one account's tokens means filtering that signature across *every* address, so ERC-20 transfers are necessarily caught too — and on a real account they **outnumber the NFT ones**.

They differ only in arity: ERC-721 indexes the token id (4 topics), ERC-20 leaves the value in data (3 topics). So `decodeEventLog` *fails* rather than reading a balance as a token id, the core records `decodeError` on the event, and the engine routes it to `handleUnparsedEvent` instead of `onTransfer`. The example counts them and puts the number on screen, because a silent drop invites a reader to wonder why a token is missing.

## Choosing where the state lives

One line, in `browser/main.ts`:

```ts
const store = await createBrowserStateStore(NFTProcessor.entities, {databaseName: `etherfold-nfts-${chainId}-${account}`});
```

Versioned rows in IndexedDB: the browser default, decided on measurement in [ADR-0024](../../docs/adr/0024-indexeddb-is-the-browser-default-until-four-things-are-true-at-once.md). Comment it out and uncomment the alternative directly below it to get `PatchStateStore` — current state as a plain object, history as immer reverse patches. **The processor does not change**: not a handler, not a declaration, not an import. What changes is what the page reports:

```
State lives in   retention: revert-only, as-of reads: no, survives a reload: NO (memory-only, ADR-0023)
```

The light store is memory-only by design ([ADR-0023](../../docs/adr/0023-the-patch-store-is-memory-only-and-refuses-a-revert-it-cannot-complete.md)), so a reload legitimately starts over — read off `store.capabilities` at startup rather than discovered from an empty tab.

## Why there are two entities

```ts
{name: 'nft',       id: ['tokenAddress', 'tokenID'],          fields: {owner: 'text'}}
{name: 'ownership', id: ['owner', 'tokenAddress', 'tokenID'], fields: {}}
```

`nft` answers *"who owns this token"*. This example asks the opposite — *"which tokens does this account own"* — and that **cannot** be served from `nft`, because `owner` is a field rather than part of the key.

The seam's only set read is a **prefix of the declared id plus a required limit** ([ADR-0021](../../docs/adr/0021-the-handler-seams-only-set-read-is-a-bounded-id-prefix-listing.md)), so a question that is not a prefix of some id has no cheap answer — it would be a full scan, which is exactly what the bound exists to make impossible. The answer is a second entity keyed the way the question is asked. It carries no fields: the id *is* the fact.

This is the modelling rule the spec states as *"key children by something naturally unique, never by a dense array position"*, met in the smallest real case.

## The two processors in `src/`

| file | authoring API | state |
| --- | --- | --- |
| `entities.ts` | `EntityProcessor` (`@etherfold/processor-entities`) | declared entities, written through a `MutationContext`, kept in whichever `StateStore` the deployment chose |
| `index.ts` | `JSProcessor` (`@etherfold/js-processor`) | one free-form object, mutated as an immer draft, persisted whole by a `KeepState` keeper |

`entities.ts` is what the browser app runs, and it is the same object a server runs against SQLite: nothing in it names a backend.

`index.ts` is the original, kept because the free-form path is not deprecated and `examples/web-demo` consumes it. Having both is deliberate: this is the one place in the repository where the same indexing question is written in both styles, so the cost of porting between them is readable in a diff.

## Verifying it

```sh
pnpm --filter event-processor-nfts verify:browser
```

Drives the built app in a real Chromium against the live chain, over six scenarios: endpoint-only, a single chosen wallet, the multi-wallet picker, the connected-account path, a wallet on the wrong chain, and no wallet at all. It stubs EIP-6963 wallets that proxy to a real endpoint, so "reads routed through the wallet" is *counted* rather than assumed.

**It checks its own health first, and that is not decoration.** Every request must finish, and any `content-length` must equal the bytes received. A static server that returns `200` headers and then never delivers the body makes `import()` hang forever with an empty console and `readyState` stuck at `interactive` — symptoms indistinguishable from a library bug, and the reason this file exists. When the harness is at fault it says `HARNESS UNHEALTHY` and refuses to blame the application.

## Building

```sh
pnpm --filter event-processor-nfts build          # the processors, to dist/
pnpm --filter event-processor-nfts browser:build  # the browser app, to dist/browser/
```
