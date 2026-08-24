import {createBrowserStateStore, createIndexerState} from '@etherfold/browser';
import {fromEntityProcessor} from '@etherfold/processor-entities';
// Uncomment together with the ONE LINE marked below to run on the light store.
// import {PatchStateStore} from '@etherfold/state-store-patch';
import {abi, NFTProcessor, readableTokenID} from '../src/entities.js';

/**
 * An application that indexes an ERC-721 collection in a browser tab.
 *
 * There is no server anywhere in this file. The tab talks to a JSON-RPC node,
 * decodes the logs, runs `NFTProcessor` over them and keeps the resulting rows
 * in IndexedDB -- the same processor object a server would run against SQLite.
 *
 * Read `start()` first: the store (ONE line, and the only place a backend is
 * named), the hook, and the two subscriptions that draw it. Everything above it
 * is the plumbing a real app would get from a wallet library.
 */

const params = new URLSearchParams(location.search);

/**
 * A public endpoint by default, so `pnpm --filter event-processor-nfts browser`
 * shows something without an account anywhere.
 *
 * Public endpoints rate-limit, change policy and disappear; `?rpc=` is the
 * escape hatch, and a wallet's own provider is used when there is one and no
 * `?rpc=` was given.
 */
const RPC_URL = params.get('rpc') ?? 'https://rpc.mevblocker.io';
/** Bored Ape Yacht Club on Ethereum mainnet: a standard ERC-721 that still moves. */
const CONTRACT = (params.get('contract') ?? '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D').toLowerCase();
/** How far back to start. Small on purpose: a demo should finish while you watch it. */
const BLOCKS = Number(params.get('blocks') ?? 2000);

type Eip1193 = {request(args: {method: string; params?: unknown[]}): Promise<any>};

/** The smallest EIP-1193 provider there is: JSON-RPC over `fetch`. */
function httpProvider(url: string): Eip1193 {
	let id = 0;
	return {
		async request(args) {
			const response = await fetch(url, {
				method: 'POST',
				headers: {'content-type': 'application/json'},
				body: JSON.stringify({jsonrpc: '2.0', id: ++id, method: args.method, params: args.params ?? []}),
			});
			const json = await response.json();
			if (json.error) {
				throw Object.assign(new Error(json.error.message), {code: json.error.code});
			}
			return json.result;
		},
	};
}

const injected = (window as unknown as {ethereum?: Eip1193}).ethereum;
const chosenProvider: Eip1193 = params.get('rpc') || !injected ? httpProvider(RPC_URL) : injected;

/**
 * The block THIS page load first asked the node for.
 *
 * It is the only observable difference between "resumed" and "re-indexed": both
 * end on the same rows, so the state cannot tell you which happened. A tab that
 * resumed asks from inside the window a reorg can still reach; a tab that lost
 * its cursor asks from the start block.
 */
let firstFetchFrom: number | undefined;
const provider: Eip1193 = {
	async request(args) {
		if (args.method === 'eth_getLogs' && firstFetchFrom === undefined) {
			firstFetchFrom = parseInt((args.params?.[0] as {fromBlock: string}).fromBlock.slice(2), 16);
		}
		return chosenProvider.request(args);
	},
};

const el = (id: string) => document.getElementById(id) as HTMLElement;

async function start() {
	const chainId = parseInt(await provider.request({method: 'eth_chainId'}), 16).toString();

	/**
	 * The first block to index, REMEMBERED rather than recomputed.
	 *
	 * `startBlock` is part of the indexing source, and the source is hashed into
	 * the sync context: a start block that moved with the chain tip would make
	 * every reload a different deployment, the stored state would be discarded as
	 * stale, and the tab would index from scratch each time. Which would also make
	 * this demo's most interesting property -- that a reopened tab CONTINUES --
	 * impossible to see.
	 */
	const startBlockKey = `etherfold-nfts-start-${chainId}-${CONTRACT}-${BLOCKS}`;
	let startBlock = Number(localStorage.getItem(startBlockKey));
	if (!Number.isFinite(startBlock) || startBlock <= 0) {
		const latest = parseInt(await provider.request({method: 'eth_blockNumber'}), 16);
		startBlock = Math.max(0, latest - BLOCKS);
		localStorage.setItem(startBlockKey, String(startBlock));
	}

	// ------------------------------------------------------------------
	// ONE LINE decides where the state lives. The processor does not change.
	// ------------------------------------------------------------------
	const store = await createBrowserStateStore(NFTProcessor.entities, {
		databaseName: `etherfold-nfts-${chainId}-${CONTRACT}`,
	});
	// ...or the light store instead: current state as a plain object, history as
	// immer reverse patches. It is memory-only by design (ADR-0023), so a reload
	// starts over rather than resuming -- which is the trade you are making.
	// const store = await createBrowserStateStore(NFTProcessor.entities, {
	// 	backend: (entities) => new PatchStateStore(entities, {finalityDepth: 12}),
	// });

	const indexer = createIndexerState({
		kind: 'entities',
		processor: fromEntityProcessor(NFTProcessor)(store),
	});

	await indexer.init({
		// cast because `EIP1193ProviderWithoutEvents` enumerates every JSON-RPC method
		// it knows; the twenty lines above implement the three this app uses.
		provider: provider as never,
		source: {chainId, contracts: [{abi, address: CONTRACT as `0x${string}`, startBlock}]},
	});

	// Described by what it CAN DO rather than by its class name: the capability
	// report is the thing an application is supposed to read at startup, and it is
	// the thing that changes when the one line above changes.
	const memoryOnly = (store.capabilities as {durability?: string}).durability === 'memory-only';
	el('where').textContent =
		`retention: ${store.capabilities.retention.kind}, ` +
		`as-of reads: ${store.capabilities.asOf ? 'yes' : 'no'}, ` +
		`survives a reload: ${memoryOnly ? 'NO (memory-only, ADR-0023)' : 'yes'}`;
	el('what').textContent = `${CONTRACT} on chain ${chainId}, from block ${startBlock}`;

	/**
	 * Say, in words, whether this page load RESUMED or started again.
	 *
	 * Updated from the syncing store rather than from the state store, because a
	 * tab that resumed and found no new events produces no state update at all --
	 * which is exactly the case worth showing.
	 */
	function describePageLoad() {
		el('resume').textContent =
			firstFetchFrom === undefined
				? 'nothing fetched yet'
				: firstFetchFrom > startBlock
					? `resumed: the first fetch of this page load asked for block ${firstFetchFrom}, not ${startBlock}`
					: `indexed from the start block (${startBlock}): no cursor was found`;
	}

	indexer.syncing.subscribe((syncing) => {
		const sync = syncing.lastSync;
		el('progress').textContent = sync
			? `block ${sync.lastToBlock} / ${sync.latestBlock} (${sync.totalPercentage}%)`
			: 'waiting for the node...';
		describePageLoad();
		if (syncing.error) {
			el('error').textContent = `${syncing.error.id}: ${syncing.error.message}`;
		}
	});

	/**
	 * The read side.
	 *
	 * `indexer.state` holds a READ HANDLE rather than a state object: on this path
	 * the state is rows in a store, so a consumer asks questions of it instead of
	 * being handed all of it. `listCurrent` is the seam's one set read -- a prefix
	 * of the declared id plus a required limit, which is an indexed range scan on
	 * every backend.
	 */
	async function render() {
		const view = indexer.state.$state;
		const transfers = (await view.getCurrent<{value: number}>('counter', {name: 'transfers'}))?.value ?? 0;
		const listing = await view.listCurrent<{tokenID: string; owner: string}>('nft', {tokenAddress: CONTRACT}, 25);

		el('transfers').textContent = String(transfers);
		el('tokens').innerHTML = listing.rows
			.map((row) => `<li><code>#${readableTokenID(row.tokenID)}</code> &rarr; <code>${row.owner}</code></li>`)
			.join('');
		el('truncated').textContent = listing.truncated ? '(showing the first 25)' : '';
	}

	indexer.state.subscribe(() => void render());
	await indexer.startAutoIndexing();
	await render();
}

start().catch((error) => {
	el('error').textContent = `${error?.message ?? error}`;
	console.error(error);
});
