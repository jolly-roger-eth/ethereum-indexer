import type {EIP1193Provider} from 'eip-1193';

import {
	createIndexerState,
	hash,
	type Abi,
	type AllContractData,
	type ContractData,
	type LogParseConfig,
	type EventProcessorWithInitialState,
	type LastSync,
	type LogEvent,
} from 'ethereum-indexer-browser';

type StreamData<ABI extends Abi> = {
	lastSync: LastSync<ABI>;
	eventStream: LogEvent<ABI, undefined>[];
};

import {get, set, del} from 'idb-keyval';
// import type {IDBPDatabase, DBSchema} from 'idb';
// import {openDB} from 'idb';

// interface MyDB<ABI extends Abi> extends DBSchema {
// 	keyval: {
// 		key: string;
// 		value: {
// 			lastSync: LastSync<ABI>;
// 			eventStream: EventWithId<ABI, undefined>[];
// 		};
// 	};
// }
// let _db: IDBPDatabase<MyDB<Abi>> | undefined;
// async function getDB<ABI extends Abi>(): Promise<IDBPDatabase<MyDB<ABI>>> {
// 	if (!_db) {
// 		_db = await openDB('INDEXER', 1, {
// 			upgrade(db) {
// 				db.createObjectStore('keyval');
// 			},
// 		});
// 	}
// 	return _db;
// }

function getStorageID<ProcessorConfig = undefined>(name: string, chainId: string, config: ProcessorConfig) {
	const configHash = config ? hash(config) : undefined;
	return `${name}_${chainId}${configHash ? `_${configHash}` : ''}`;
}

export function createIndexeInitializer<ABI extends Abi, ProcessResultType, ProcessorConfig = undefined>(
	name: string,
	processor: EventProcessorWithInitialState<ABI, ProcessResultType, ProcessorConfig>,
	contracts: readonly ContractData<ABI>[] | AllContractData<ABI>,
	chainId: string | undefined
) {
	const indexer = createIndexerState(processor, {
		trackNumRequests: true,
		keepState: {
			fetch: async (context) => {
				const storageID = getStorageID(name, context.source.chainId, 'config' in context ? context.config : undefined);
				const fromStorage = localStorage.getItem(storageID);
				if (!fromStorage) {
					return undefined;
				} else {
					const parsed = JSON.parse(fromStorage, (_, value) => {
						if (typeof value === 'string' && value.endsWith('n')) {
							try {
								const bn = BigInt(value.slice(0, -1));
								return bn;
							} catch (err) {
								return value;
							}
						} else {
							return value;
						}
					});
					return parsed;
				}
			},
			save: async (context, all) => {
				const storageID = getStorageID(name, context.source.chainId, 'config' in context ? context.config : undefined);
				localStorage.setItem(
					storageID,
					JSON.stringify({...all, __VERSION__: context.version}, (_, value) =>
						typeof value === 'bigint' ? value.toString() + 'n' : value
					)
				);
			},
			clear: async (context) => {
				const storageID = getStorageID(name, context.source.chainId, 'config' in context ? context.config : undefined);
				localStorage.removeItem(storageID);
			},
		},
		keepStream: {
			fetchFrom: async (source, fromBlock) => {
				const storageID = `stream_${name}_${source.chainId}`;

				const existingStream = await get<StreamData<ABI>>(storageID);
				return existingStream
					? {
							eventStream: existingStream.eventStream.filter((v: any) => v.blockNumber >= fromBlock),
							lastSync: existingStream.lastSync,
					  }
					: undefined;
			},
			saveNewEvents: async (source, stream) => {
				const storageID = `stream_${name}_${source.chainId}`;

				const existingStream = await get<StreamData<ABI>>(storageID);

				if (existingStream && existingStream.eventStream.length > 0) {
					if (stream.eventStream.length > 0) {
						const eventStreamToSave = existingStream.eventStream.concat(stream.eventStream);
						await set(storageID, {lastSync: stream.lastSync, eventStream: eventStreamToSave});
					} else {
						await set(storageID, {lastSync: stream.lastSync, eventStream: existingStream.eventStream});
					}
				} else {
					await set(storageID, stream);
				}
			},
			async clear(source) {
				const storageID = `stream_${name}_${source.chainId}`;
				await del(storageID, undefined);
			},
		},
	});

	const {init, indexToLatest, indexMore, startAutoIndexing, indexMoreAndCatchupIfNeeded} = indexer;

	function indexContinuously(provider: EIP1193Provider) {
		let timeout: number | undefined;
		let currentSubscriptionId: `0x${string}` | undefined;

		function onNewHeads(message: {type: string; data: {subscription: `0x${string}`}}) {
			if (message.type === 'eth_subscription') {
				if (message?.data?.subscription === currentSubscriptionId) {
					resetNewHeadsTimeout();
					indexMoreAndCatchupIfNeeded();
				}
			}
		}

		async function onTimeout() {
			console.log(`TIMEOUT for newHeads, fallback on timer...`);

			try {
				await provider.request({method: 'eth_unsubscribe', params: [currentSubscriptionId]});
			} catch (err) {
				console.error(`failed to unsubscribe`);
			}
			currentSubscriptionId = undefined;
			startAutoIndexing();
		}

		function triggerIndexing() {
			// we force a trigger as it seems Metamask fails to keep sending `newHeads` when chain changed
			// TODO make a reproduction case and post an issue
			setTimeout(() => indexer.indexMoreAndCatchupIfNeeded(), 500);
		}

		function resetNewHeadsTimeout() {
			clearTimeout(timeout);
			timeout = setTimeout(onTimeout, 20000);
		}

		function listenTo(subscriptionId: `0x${string}`) {
			currentSubscriptionId = subscriptionId;
			resetNewHeadsTimeout();
		}

		if (provider.on) {
			provider
				.request({method: 'eth_subscribe', params: ['newHeads']})
				.then((subscriptionId: `0x${string}`) => {
					provider.on('message', onNewHeads);
					provider.on('chainChanged', triggerIndexing);
					listenTo(subscriptionId);
				})
				.catch((err) => {
					console.error(
						`Error making newHeads subscription: ${err.message}.
					 Code: ${err.code}. Data: ${err.data}
					 Falling back on timeout
					 `
					);
					startAutoIndexing();
				});
		} else {
			startAutoIndexing();
		}
	}

	function initialize(
		connection: {ethereum: EIP1193Provider; accounts: readonly `0x${string}`[]; chainId: string},
		config?: {
			parseConfig?: LogParseConfig;
			processorConfig?: ProcessorConfig;
		}
	) {
		const provider = connection.ethereum;
		init(
			{
				provider,
				source: {
					chainId: chainId || connection.chainId,
					contracts,
				},
				config: config?.parseConfig ? {stream: {parse: config.parseConfig}} : undefined,
			},
			config?.processorConfig
		).then(() => {
			indexToLatest().then(() => {});
			indexContinuously(connection.ethereum);
		});
	}
	(window as any).indexer = indexer;
	return {...indexer, initialize};
}
