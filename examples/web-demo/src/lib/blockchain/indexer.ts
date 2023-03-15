import type {EIP1193Provider} from 'eip-1193';

import {
	createIndexerState,
	type Abi,
	type AllContractData,
	type ContractData,
	type LogParseConfig,
	type EventProcessorWithInitialState,
	type LastSync,
	type EventWithId,
} from 'ethereum-indexer-browser';
import {hash} from '../utils/hash';

type StreamData<ABI extends Abi> = {
	lastSync: LastSync<ABI>;
	eventStream: EventWithId<ABI, undefined>[];
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

async function getStorageID<ProcessorConfig = undefined>(name: string, chainId: string, config: ProcessorConfig) {
	const configHash = config ? await hash(config) : undefined;
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
			fetcher: async (context) => {
				const storageID = await getStorageID(
					name,
					context.source.chainId,
					'config' in context ? context.config : undefined
				);
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
					// no need anymore as this is handled by the indexer and the lastSync.context values
					// if ((context.version || parsed.__VERSION__) && parsed.__VERSION__ !== context.version) {
					// 	console.log(`NEW VERSION DETECTED, GET RID OF STATE`);
					// 	localStorage.removeItem(storageID);
					// 	return undefined;
					// }
					return parsed;
				}
			},
			saver: async (context, all) => {
				const storageID = await getStorageID(
					name,
					context.source.chainId,
					'config' in context ? context.config : undefined
				);
				localStorage.setItem(
					storageID,
					JSON.stringify({...all, __VERSION__: context.version}, (_, value) =>
						typeof value === 'bigint' ? value.toString() + 'n' : value
					)
				);
			},
		},
		keepStream: {
			fetchFrom: async (source, nextStreamId) => {
				const storageID = `stream_${name}_${source.chainId}`;

				const existingStream = await get<StreamData<ABI>>(storageID);
				return existingStream && existingStream.eventStream[0]?.streamID <= nextStreamId
					? {
							eventStream: existingStream.eventStream.filter((v: any) => v.streamID >= nextStreamId),
							lastSync: existingStream.lastSync,
					  }
					: undefined;
			},
			saveNewEvents: async (source, stream) => {
				const storageID = `stream_${name}_${source.chainId}`;

				const existingStream = await get<StreamData<ABI>>(storageID);

				if (existingStream && existingStream.eventStream.length > 0) {
					if (stream.eventStream.length > 0) {
						const expectedNextStreamID = existingStream.eventStream[existingStream.eventStream.length - 1].streamID + 1;
						if (expectedNextStreamID !== stream.eventStream[0].streamID) {
							throw new Error(
								`expect stream to be consecutive, got streamID ${stream.eventStream[0].streamID} while expecting ${expectedNextStreamID}`
							);
						}
						const eventStreamToSave = existingStream.eventStream.concat(stream.eventStream);
						await set(storageID, {lastSync: stream.lastSync, eventStream: eventStreamToSave});
					} else {
						await set(storageID, {lastSync: stream.lastSync, eventStream: existingStream.eventStream});
					}
				} else if (stream.eventStream.length > 0 && stream.eventStream[0].streamID !== 1) {
					// throw new Error(`did not save previous events`);
					await set(storageID, stream);
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

	const {init, indexToLatest, indexMore, startAutoIndexing} = indexer;
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
		);
		indexToLatest().then(() => {
			provider
				.request({method: 'eth_subscribe', params: ['newHeads']})
				.then((subscriptionId: unknown) => {
					if ((provider as any).on) {
						(provider as any).on('message', (message: {type: string; data: {subscription: `0x${string}`}}) => {
							if (message.type === 'eth_subscription') {
								if (message?.data?.subscription === subscriptionId) {
									indexMore();
								}
							}
						});
					}
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
		});
	}
	(window as any).indexer = indexer;
	return {...indexer, initialize};
}
