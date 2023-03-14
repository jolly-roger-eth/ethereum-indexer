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
					JSON.stringify(all, (_, value) => (typeof value === 'bigint' ? value.toString() + 'n' : value))
				);
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
				config: config?.parseConfig ? {parseConfig: config.parseConfig} : undefined,
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
	return {...indexer, initialize};
}
