import type {EIP1193Provider} from 'eip-1193';

import {
	createIndexerState,
	type Abi,
	type AllContractData,
	type ContractData,
	type LogParseConfig,
	type EventProcessorWithInitialState,
} from 'ethereum-indexer-browser';

export function createIndexeInitializer<ABI extends Abi, ProcessResultType, ProcessorConfig = void>(
	factoryOrProcessor:
		| (() => EventProcessorWithInitialState<ABI, ProcessResultType, ProcessorConfig>)
		| EventProcessorWithInitialState<ABI, ProcessResultType, ProcessorConfig>,
	contracts: readonly ContractData<ABI>[] | AllContractData<ABI>,
	chainId: string | undefined
) {
	const stores = createIndexerState(factoryOrProcessor, {
		trackNumRequests: true,
	});

	const {setup, indexToLatest, indexMore, startAutoIndexing} = stores;
	function initialize(
		connection: {ethereum: EIP1193Provider; accounts: readonly `0x${string}`[]; chainId: string},
		config?: {
			parseConfig?: LogParseConfig;
			processorConfig?: ProcessorConfig;
		}
	) {
		const provider = connection.ethereum;
		setup(
			provider,
			{
				chainId: chainId || connection.chainId,
				contracts,
			},
			{
				indexer: config?.parseConfig
					? {
							parseConfig: config?.parseConfig,
					  }
					: undefined,
				processor: config?.processorConfig,
			}
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
	return {...stores, initialize};
}
