import type {EIP1193Provider} from 'eip-1193';
import {
	createIndexerState,
	type Abi,
	type AllContractData,
	type ContractData,
	type EventProcessor,
	type LogParseConfig,
} from 'ethereum-indexer-browser';

export function createIndexerFromFactory(
	factory: (params: any) => EventProcessor<Abi, any>,
	contracts: ContractData<Abi>[] | AllContractData<Abi>,
	chainId: string
) {
	const processor = factory({
		TODO: '//TODO', // TODO
	});
	const stores = createIndexerState(processor, {
		trackNumRequests: true,
	});

	const {setup, indexToLatest, indexMore, startAutoIndexing} = stores;
	function initialize(
		connection: {ethereum: EIP1193Provider; accounts: `0x${string}`[]},
		parseConfig?: LogParseConfig
	) {
		const provider = connection.ethereum;
		setup(
			provider,
			{
				chainId,
				contracts,
			},
			{
				parseConfig,
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
