import {processor as processorFactory, contractsDataPerChain} from 'event-processor-conquest-eth';
import type {EIP1193Provider} from 'eip-1193';
import {createIndexerState} from 'ethereum-indexer-browser';

export const {state, syncing, status, setup, indexToLatest, indexMore, startAutoIndexing} = createIndexerState(
	processorFactory,
	{trackNumRequests: true}
);

export function initialize(provider: EIP1193Provider) {
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

export function stringify(v: any) {
	return JSON.stringify(v, (k, v) => (typeof v === 'bigint' ? v.toString() + 'n' : v), 2);
}

if (typeof window !== 'undefined') {
	(window as any).state = state;
	(window as any).status = status;
	(window as any).syncing = syncing;
}
