import type {
	Abi,
	EventProcessor,
	EventProcessorWithInitialState,
	IndexerConfig,
	IndexingSource,
	LastSync,
} from 'ethereum-indexer';
import {EthereumIndexer} from 'ethereum-indexer';
import {createRootStore, createStore} from './utils/stores';
import type {EIP1193ProviderWithoutEvents} from 'eip-1193';
import {formatLastSync} from './utils/format';

export type ExtendedLastSync<ABI extends Abi> = LastSync<ABI> & {
	numBlocksProcessedSoFar: number;
	syncPercentage: number;
	totalPercentage: number;
};

export type SyncingState<ABI extends Abi> = {
	waitingForProvider: boolean;
	autoIndexing: boolean;
	loading: boolean;
	processingFetchedLogs: boolean;
	fetchingLogs: boolean;
	catchingUp: boolean;
	numRequests?: number;
	lastSync?: ExtendedLastSync<ABI>;
	error?: {message: string; code: number};
};

export type StatusState = {
	state: 'Idle' | 'Loading' | 'Fetching' | 'Processing' | 'Done';
};

export function createIndexerState<ABI extends Abi, ProcessResultType, ProcessorConfig>(
	factoryOrProcessor:
		| (() => EventProcessorWithInitialState<ABI, ProcessResultType, ProcessorConfig>)
		| EventProcessorWithInitialState<ABI, ProcessResultType, ProcessorConfig>,
	options?: {
		trackNumRequests?: boolean;
	}
) {
	const {
		$state: $syncing,
		set: setSyncing,
		readable: readableSyncing,
	} = createStore<SyncingState<ABI>>({
		waitingForProvider: true,
		loading: false,
		autoIndexing: false,
		catchingUp: false,
		fetchingLogs: false,
		processingFetchedLogs: false,
		numRequests: options?.trackNumRequests ? 0 : undefined,
	});

	const processor = typeof factoryOrProcessor == 'function' ? factoryOrProcessor() : factoryOrProcessor;
	const initialState = processor.createInitialState();

	const {set: setStatus, readable: readableStatus} = createStore<StatusState>({state: 'Idle'});
	const {set: setState, readable: readableState} = createRootStore<ProcessResultType>(initialState);

	let indexer: EthereumIndexer<ABI, ProcessResultType> | undefined;
	let indexingTimeout: number | undefined;
	let autoIndexingInterval: number = 4;

	function setup(
		provider: EIP1193ProviderWithoutEvents,
		source: IndexingSource<ABI>,
		config?: {
			processor?: ProcessorConfig;
			indexer?: IndexerConfig<ABI>;
		}
	) {
		const indexerConfig = config?.indexer || {};
		if (options?.trackNumRequests) {
			provider = new Proxy(provider, {
				get(target, p, receiver) {
					if (p === 'request') {
						return (args: {method: string; params?: readonly unknown[]}) => {
							setSyncing({numRequests: ($syncing.numRequests || 0) + 1});
							return target[p](args as any);
						};
					}
					return (target as any)[p];
				},
			});
		}
		if (processor.configure) {
			processor.configure(config?.processor);
		}
		indexer = new EthereumIndexer<ABI, ProcessResultType>(provider, processor, source, indexerConfig);
		setSyncing({waitingForProvider: false});
	}

	function setLastSync(lastSync: LastSync<ABI>) {
		if (!indexer) {
			throw new Error(`no indexer`);
		}
		const startingBlock = indexer.defaultFromBlock;
		const latestBlock = lastSync.latestBlock;
		const lastToBlock = lastSync.lastToBlock;

		const totalToProcess = latestBlock - startingBlock;
		const numBlocksProcessedSoFar = Math.max(0, lastToBlock - startingBlock);

		const lastSyncObject = formatLastSync(lastSync);
		lastSyncObject.numBlocksProcessedSoFar = numBlocksProcessedSoFar;
		lastSyncObject.syncPercentage = Math.floor((numBlocksProcessedSoFar * 1000000) / totalToProcess) / 10000;
		lastSyncObject.totalPercentage = Math.floor((lastToBlock * 1000000) / latestBlock) / 10000;

		setSyncing({lastSync: lastSyncObject});
	}

	async function setupIndexing(): Promise<LastSync<ABI>> {
		if ($syncing.lastSync) {
			return $syncing.lastSync;
		}
		if (!indexer) {
			throw new Error(`no indexer`);
		}
		indexer.onLoad = async (loadingState) => {
			setStatus({state: loadingState});
			if (loadingState === 'Loading') {
				// namedLogger.info('indexer Loading');
				// this.store.update((state) => {
				// 	state.loading = true;
				// 	this.loading = true;
				// 	return state;
				// });
			} else if (loadingState === 'Fetching') {
				// namedLogger.info('indexer Fetching');
				setSyncing({fetchingLogs: true});
			} else if (loadingState === 'Processing') {
				// namedLogger.info('indexer Processing');
				setSyncing({fetchingLogs: false, processingFetchedLogs: true});
			} else if (loadingState === 'Done') {
				// namedLogger.info('indexer Init DOne');
				setSyncing({processingFetchedLogs: false});
			}
			// await wait(0.001); // allow svelte to capture it
		};
		indexer.onProcessed = (state) => {
			setState(state);
		};

		// namedLogger.info(`loading...`);
		setSyncing({loading: true});
		try {
			const lastSync = await indexer.load();
			// namedLogger.info('...done loading');
			setSyncing({loading: false});
			return lastSync;
		} finally {
			setSyncing({loading: false, error: {message: 'Failed to load', code: 1}}); // TODO code})
		}
	}

	async function indexMore(): Promise<LastSync<ABI>> {
		await setupIndexing();
		if (!indexer) {
			throw new Error(`no indexer`);
		}
		const lastSync = await indexer.indexMore();
		setLastSync(lastSync);
		return lastSync;
	}

	async function indexToLatest() {
		let lastSync: LastSync<ABI> = await setupIndexing();
		setLastSync(lastSync);
		if (!indexer) {
			throw new Error(`no indexer`);
		}

		// namedLogger.info(`indexing...`);
		setSyncing({catchingUp: true});
		try {
			lastSync = await indexer.indexMore();
			setLastSync(lastSync);
		} catch (err) {
			// namedLogger.error('ERROR, retry indexToLatest in 1 second', err);
			lastSync = await new Promise((resolve) => {
				setTimeout(async () => {
					const result = await indexToLatest();
					resolve(result);
				}, 1000);
			});
		}

		if (!lastSync) {
			throw new Error(`no lastSync`);
		}

		// const latestBlock = await this.eip1193Provider.request({method: 'eth_blockNumber', params:[]});
		while (lastSync.lastToBlock !== lastSync.latestBlock) {
			// namedLogger.info(`indexing...`);
			try {
				lastSync = await indexer.indexMore();
				setLastSync(lastSync);
			} catch (err) {
				// namedLogger.error('ERROR, retry indexing in 1 second', err);
				await new Promise((resolve) => {
					setTimeout(resolve, 1000);
				});
			}
		}
		setSyncing({
			catchingUp: false,
		});
		// namedLogger.info(`... done.`);
		return lastSync;
	}

	async function startAutoIndexing(intervalInSeconds = 4): Promise<boolean> {
		autoIndexingInterval = intervalInSeconds;
		await setupIndexing();
		if (!$syncing.autoIndexing) {
			_auto_index();
			return true;
		} else {
			return false;
		}
	}

	function stopAutoIndexing(): boolean {
		if ($syncing.autoIndexing) {
			if (indexingTimeout) {
				clearTimeout(indexingTimeout);
			}
			setSyncing({
				autoIndexing: false,
			});
			return true;
		} else {
			return false;
		}
	}

	async function _auto_index() {
		setSyncing({autoIndexing: true});
		try {
			const lastSync = await indexMore();
			if (lastSync.latestBlock - lastSync.lastToBlock < 1) {
				// the latestblock fetched is smaller or equal than the last synced blocked
				// let's wait
				indexingTimeout = setTimeout(_auto_index, autoIndexingInterval * 1000);
			} else {
				// here the latestBlock is ahead, let's sync quickly again
				indexingTimeout = setTimeout(_auto_index, 1);
			}
		} catch (err) {
			// namedLogger.error('ERROR, retry in 1 seconds', err);
			indexingTimeout = setTimeout(_auto_index, autoIndexingInterval * 1000);
			return;
		}
	}

	return {
		syncing: {
			...readableSyncing,
		},
		state: {
			...readableState,
		},
		status: {
			...readableStatus,
		},
		setup,
		indexToLatest,
		indexMore,
		startAutoIndexing,
		stopAutoIndexing,
	};
}
