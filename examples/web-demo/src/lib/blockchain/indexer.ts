import type {EIP1193Provider} from 'eip-1193';

import {
	createIndexerState,
	type Abi,
	type AllContractData,
	type ContractData,
	type LogParseConfig,
	type EventProcessorWithInitialState,
	keepStateOnLocalStorage,
	keepStreamOnIndexedDB,
} from 'ethereum-indexer-browser';

export function createIndexeInitializer<ABI extends Abi, ProcessResultType, ProcessorConfig = undefined>(
	name: string,
	processor: EventProcessorWithInitialState<ABI, ProcessResultType, ProcessorConfig>,
	contracts: readonly ContractData<ABI>[] | AllContractData<ABI>,
	chainId: string | undefined
) {
	const indexer = createIndexerState(processor, {
		trackNumRequests: true,
		keepState: keepStateOnLocalStorage(name),
		keepStream: keepStreamOnIndexedDB(name),
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
