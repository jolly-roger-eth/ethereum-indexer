import {processor as processorFactory, contractsDataPerChain} from 'event-processor-conquest-eth';
import {BrowserIndexer} from 'ethereum-indexer-browser';
import {readable} from 'sveltore';
import type {EIP1193Provider, EventWithId, LastSync} from 'ethereum-indexer';
import {writable} from 'svelte/store';

const eip1193Provider = (window as any).ethereum as EIP1193Provider;

export const numRequests = writable(0);

const eip1193ProviderWithCounter = new Proxy(eip1193Provider, {
	get(target, p, receiver) {
		if (p === 'request') {
			return (args: {method: string; params?: readonly unknown[] | object}) => {
				numRequests.update((v) => v + 1);
				return target[p](args);
			};
		}
		return target[p];
	},
});

export const processor = processorFactory({
	TODO: '//TODO', // TODO
});
export const browserIndexer = new BrowserIndexer(processor, contractsDataPerChain[100], eip1193ProviderWithCounter, {
	saveAppendedStream: async (stream) => {
		const streamAsString = localStorage.getItem('stream');
		if (streamAsString) {
			const existingStream: {lastSync: LastSync; eventStream: EventWithId[]} = JSON.parse(streamAsString);
			// TODO check streamID is exactly +1 next
			const eventStreamToSave = existingStream.eventStream.concat(stream.eventStream);
			// console.log(`saving nextStreamID: ${stream.lastSync.nextStreamID}, events : ${eventStreamToSave.length}`);
			localStorage.setItem('stream', JSON.stringify({lastSync: stream.lastSync, eventStream: eventStreamToSave}));
		} else if (stream.eventStream[0].streamID !== 1) {
			throw new Error(`did not save previous events`);
		} else {
			localStorage.setItem('stream', JSON.stringify(stream));
		}
	},
	fetchExistingStream: async (nextStreamId) => {
		// TODO fetch from remote too
		const empty = {
			lastSync: {
				lastToBlock: 0,
				latestBlock: 0,
				nextStreamID: 1,
				unconfirmedBlocks: [],
			},
			eventStream: [],
		};
		const streamAsString = localStorage.getItem('stream');
		// console.log(streamAsString);
		const stream: {lastSync: LastSync; eventStream: EventWithId[]} = JSON.parse(streamAsString);
		return stream
			? {
					eventStream: stream.eventStream.filter((v) => v.streamID >= nextStreamId),
					lastSync: stream.lastSync,
			  }
			: empty;
	},
});

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
