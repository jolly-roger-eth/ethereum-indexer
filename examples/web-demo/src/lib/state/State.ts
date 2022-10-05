import {processor as processorFactory, contractsDataPerChain} from 'event-processor-conquest-eth';
import {BrowserIndexer} from 'ethereum-indexer-browser';
import {readable} from 'sveltore';
import type {EIP1193Provider, LastSync} from 'ethereum-indexer';

const eip1193Provider = (window as any).ethereum as EIP1193Provider;

export const processor = processorFactory('local');
export const browserIndexer = new BrowserIndexer(processor, contractsDataPerChain[100], eip1193Provider);

export function stringify(v) {
	return JSON.stringify(v, (k, v) => (typeof v === 'bigint' ? v.toString() + 'n' : v), 2);
}

browserIndexer.indexToLatest().then(() => {
	eip1193Provider
		.request({method: 'eth_subscribe', params: ['newHeads']})
		.then((subscriptionId) => {
			(eip1193Provider as any).on('message', (message) => {
				if (message.type === 'eth_subscription') {
					const {data} = message;
					if (data.subscription === subscriptionId) {
						if ('result' in data && typeof data.result === 'object') {
							const block = data.result;
							// console.log(`New block ${block.number}:`, block);
							browserIndexer.indexMore();
						} else {
							console.error(`Something went wrong: ${data.result}`);
						}
					}
				}
			});
		})
		.catch((err: any) => {
			console.error(
				`Error making newHeads subscription: ${err.message}.
     Code: ${err.code}. Data: ${err.data}
     Falling back on timeout
     `
			);
			browserIndexer.startAutoIndexing();
		});
});

export const state = readable(undefined, (set) => {
	browserIndexer.subscribe((lastSync) => {
		set(processor.json);
	});
});

(window as any).browserIndexer = browserIndexer;
(window as any).state = state;
