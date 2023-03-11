import {processor as processorFactory, contractsDataPerChain} from 'event-processor-conquest-eth';
import type {EIP1193Provider} from 'eip-1193';
import {createIndexerState} from 'ethereum-indexer-browser';
import {writable} from 'svelte/store';

export const processor = processorFactory({
	TODO: '//TODO', // TODO
});

export const {state, syncing, status, setup, indexToLatest, indexMore, startAutoIndexing} = createIndexerState(
	processor,
	{trackNumRequests: true}
);

function initialize(provider: EIP1193Provider) {
	setup(provider, {
		chainId: '100',
		contracts: contractsDataPerChain['100'],
	});
	indexToLatest().then(() => {
		provider
			.request({method: 'eth_subscribe', params: ['newHeads']})
			.then((subscriptionId: unknown) => {
				if ((provider as any).on) {
					(provider as any).on('message', (message: {type: string; data: any}) => {
						if (message.type === 'eth_subscription') {
							if (message?.data?.subscription === subscriptionId) {
								indexMore();
							}
						}
					});
				}
			})
			.catch((err: any) => {
				console.error(
					`Error making newHeads subscription: ${err.message}.
			 Code: ${err.code}. Data: ${err.data}
			 Falling back on timeout
			 `
				);
				startAutoIndexing();
			});
	});
}

export type IndexerLoading = {state: 'Idle' | 'Loading' | 'SwithingChain' | 'Ready'; error?: string};
const store = writable<IndexerLoading>({
	state: 'Idle',
});
export const indexer = {
	subscribe: store.subscribe,
	start,
};

async function start() {
	store.set({state: 'Loading'});
	const ethereum: EIP1193Provider = (window as any).ethereum;
	if (ethereum) {
		const chainIdAsHex = await ethereum.request({method: 'eth_chainId'});
		const chainId = parseInt(chainIdAsHex.slice(2), 16).toString();
		if (chainId !== '100') {
			store.set({state: 'SwithingChain'});
			try {
				await ethereum.request({method: 'wallet_switchEthereumChain', params: [{chainId: `0x64`}]});
			} catch (err) {
				try {
					await ethereum.request({
						method: 'wallet_addEthereumChain',
						params: [
							{
								chainId: `0x64`,
								rpcUrls: ['https://rpc.gnosischain.com/'],
								blockExplorerUrls: ['https://blockscout.com/xdai/mainnet/'],
								chainName: 'Gnosis',
								nativeCurrency: {
									decimals: 18,
									name: 'Gnosis',
									symbol: 'xDAI',
								},
							},
						],
					});
				} catch (err) {
					store.set({state: 'Idle', error: 'Failed to change to chain '});
				}
			}
		}
		const newCainIdAsHex = await ethereum.request({method: 'eth_chainId'});
		const newChainId = parseInt(newCainIdAsHex.slice(2), 16).toString();
		if (newChainId !== '100') {
			store.set({state: 'Idle', error: 'Failed to change to chain '});
		} else {
			store.set({state: 'Ready'});
			initialize(ethereum);
		}
	}
}

export function stringify(v: any) {
	return JSON.stringify(v, (k, v) => (typeof v === 'bigint' ? v.toString() + 'n' : v), 2);
}

if (typeof window !== 'undefined') {
	(window as any).state = state;
	(window as any).status = status;
	(window as any).syncing = syncing;
}
