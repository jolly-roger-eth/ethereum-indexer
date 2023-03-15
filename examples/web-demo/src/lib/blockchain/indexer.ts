import type {EIP1193Provider} from 'eip-1193';

import {
	createIndexerState,
	type Abi,
	type AllContractData,
	type ContractData,
	type LogParseConfig,
	type EventProcessorWithInitialState,
} from 'ethereum-indexer-browser';
import {hash} from '../utils/hash';

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
					if ((context.version || parsed.__VERSION__) && parsed.__VERSION__ !== context.version) {
						console.log(`NEW VERSION DETECTED, GET RID OF STATE`);
						localStorage.removeItem(storageID);
						return undefined;
					}
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
			fetcher: async (source, nextStreamId) => {
				const empty = {
					lastSync: {
						lastToBlock: 0,
						latestBlock: 0,
						nextStreamID: 1,
						unconfirmedBlocks: [],
					},
					eventStream: [],
				};

				const storageID = `stream_${name}_${source.chainId}`;
				const fromStorage = localStorage.getItem(storageID);
				const stream = fromStorage
					? JSON.parse(fromStorage, (key, value) => {
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
					  })
					: undefined;
				return stream
					? {
							eventStream: stream.eventStream.filter((v: any) => v.streamID >= nextStreamId),
							lastSync: stream.lastSync,
					  }
					: empty;
			},
			saver: async (source, stream) => {
				const storageID = `stream_${name}_${source.chainId}`;
				const fromStorage = localStorage.getItem(storageID);
				if (fromStorage) {
					const existingStream = JSON.parse(fromStorage, (key, value) => {
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
					// TODO check streamID is exactly +1 next
					const eventStreamToSave = existingStream.eventStream.concat(stream.eventStream);
					// console.log(`saving nextStreamID: ${stream.lastSync.nextStreamID}, events : ${eventStreamToSave.length}`);
					localStorage.setItem(
						storageID,
						JSON.stringify(
							{lastSync: stream.lastSync, eventStream: eventStreamToSave},
							(key, value) => (typeof value === 'bigint' ? value.toString() + `n` : value) // return everything else unchanged
						)
					);
				} else if (stream.eventStream.length > 0 && stream.eventStream[0].streamID !== 1) {
					throw new Error(`did not save previous events`);
				} else {
					localStorage.setItem(
						storageID,
						JSON.stringify(
							stream,
							(key, value) => (typeof value === 'bigint' ? value.toString() + `n` : value) // return everything else unchanged
						)
					);
				}
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
