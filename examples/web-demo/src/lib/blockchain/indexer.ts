import type {EIP1193Provider} from 'eip-1193';
import {
	createIndexerState,
	type Abi,
	type AllContractData,
	type ContractData,
	type EventProcessor,
	type LogParseConfig,
} from 'ethereum-indexer-browser';

export function createIndexerFromFactory<ProcessResultType, ProcessorConfig = void>(
	factory: (config: ProcessorConfig) => EventProcessor<Abi, ProcessResultType>,
	contracts: ContractData<Abi>[] | AllContractData<Abi>,
	chainId: string
) {
	const stores = createIndexerState(factory, {
		trackNumRequests: true,
	});

	const {setup, indexToLatest, indexMore, startAutoIndexing} = stores;
	function initialize(
		connection: {ethereum: EIP1193Provider; accounts: `0x${string}`[]},
		config?: {
			parseConfig?: LogParseConfig;
			processorConfig?: ProcessorConfig;
		}
	) {
		const provider = connection.ethereum;
		setup(
			provider,
			{
				chainId,
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
	return {...stores, initialize};
}
