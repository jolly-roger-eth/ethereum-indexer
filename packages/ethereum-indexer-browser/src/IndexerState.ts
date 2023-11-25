import type {
	Abi,
	EventProcessorWithInitialState,
	IndexingSource,
	LastSync,
	ExistingStream,
	KeepState,
	ProvidedStreamConfig,
	ProvidedIndexerConfig,
} from 'ethereum-indexer';
import {EthereumIndexer} from 'ethereum-indexer';
import {createRootStore, createStore} from './utils/stores';
import {ReactHooks, useStores} from 'use-stores';
import type {EIP1193ProviderWithoutEvents} from 'eip-1193';
import {formatLastSync} from './utils/format';
import {logs} from 'named-logs';
import {wait} from './utils/time';
const namedLogger = logs('ethereum-indexer-browser');

export type ExtendedLastSync<ABI extends Abi> = LastSync<ABI> & {
	numBlocksProcessedSoFar: number;
	syncPercentage: number;
	totalPercentage: number;
};

export type ErrorCode = string;

export type SyncingState<ABI extends Abi> = {
	waitingForProvider: boolean;
	autoIndexing: boolean;
	loading: boolean;
	processingFetchedLogs: boolean;
	fetchingLogs: boolean;
	catchingUp: boolean;
	numRequests?: number;
	lastSync?: ExtendedLastSync<ABI>;
	error?: {message: string; id: ErrorCode; code?: number};
};

export type StatusState = {
	state: 'Idle' | 'Loading' | 'Fetching' | 'Processing' | 'Loaded';
};

type InitFunction<ABI extends Abi, ProcessorConfig = undefined> = ProcessorConfig extends undefined
	? (indexerSetup: {
			provider: EIP1193ProviderWithoutEvents;
			source: IndexingSource<ABI>;
			config?: ProvidedIndexerConfig<ABI>;
	  }) => Promise<void>
	: (
			indexerSetup: {
				provider: EIP1193ProviderWithoutEvents;
				source: IndexingSource<ABI>;
				config?: ProvidedIndexerConfig<ABI>;
			},
			processorConfig: ProcessorConfig
	  ) => Promise<void>;

export function createIndexerState<ABI extends Abi, ProcessResultType, ProcessorConfig = undefined>(
	processor: EventProcessorWithInitialState<ABI, ProcessResultType, ProcessorConfig>,
	options?: {
		trackNumRequests?: boolean;
		logRequests?: boolean;
		keepState?: KeepState<ABI, ProcessResultType, unknown, ProcessorConfig>;
		keepStream?: ExistingStream<ABI>;
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

	if (options?.keepState) {
		if (!(processor as any).keepState) {
			throw new Error(`this processor do not support "keepState" config`);
		}
		(processor as any).keepState(options.keepState);
	}
	const initialState = processor.createInitialState();

	const {set: setStatus, readable: readableStatus} = createStore<StatusState>({state: 'Idle'});
	const {set: setState, readable: readableState} = createRootStore<ProcessResultType>(initialState);

	let indexer: EthereumIndexer<ABI, ProcessResultType> | undefined;
	let indexingTimeout: number | undefined;
	let autoIndexingInterval: number = 4;

	async function init(
		indexerSetup: {
			provider: EIP1193ProviderWithoutEvents;
			source: IndexingSource<ABI>;
			config?: ProvidedIndexerConfig<ABI>;
		},
		processorConfig?: ProcessorConfig
	) {
		const config = {...{}, keepStream: options?.keepStream, ...(indexerSetup.config || {})};
		const source = indexerSetup.source;

		const provider = options?.trackNumRequests || options?.logRequests
			? new Proxy(indexerSetup.provider, {
					get(target, p, receiver) {
						if (p === 'request') {
							return (args: {method: string; params?: readonly unknown[]}) => {
								if (options.trackNumRequests) {
									setSyncing({numRequests: ($syncing.numRequests || 0) + 1});
								}
								if (options.logRequests) {
									console.log(JSON.stringify(args));
								}
								return target[p](args as any);
							};
						}
						return (target as any)[p];
					},
			  })
			: indexerSetup.provider;
		if (processor.configure && processorConfig) {
			processor.configure(processorConfig);
		}
		indexer = new EthereumIndexer<ABI, ProcessResultType>(provider, processor, source, config);
		setSyncing({waitingForProvider: false});
	}

	let lastLastToBlock: number;
	function setLastSync(lastSync: LastSync<ABI>) {
		if (!lastSync) {
			return;
		}
		if (!indexer) {
			throw new Error(`no indexer`);
		}
		const startingBlock = indexer.defaultFromBlock;
		const latestBlock = lastSync.latestBlock;
		const lastToBlock = lastSync.lastToBlock;
		lastLastToBlock = lastToBlock;

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
			} else if (loadingState === 'Fetching') {
				setSyncing({fetchingLogs: true});
			} else if (loadingState === 'Processing') {
				setSyncing({fetchingLogs: false, processingFetchedLogs: true});
			} else if (loadingState === 'Loaded') {
				setSyncing({processingFetchedLogs: false});
			}
			await wait(0.001); // allow propagation if the whole proces is synchronous
		};
		indexer.onLastSyncUpdated = (lastSync) => {
			// should we also wait ?
			setLastSync(lastSync);
		};
		indexer.onStateUpdated = (state) => {
			setState(state);
		};

		setSyncing({loading: true});
		try {
			const lastSync = await indexer.load();
			setSyncing({loading: false});
			return lastSync;
		} finally {
			setSyncing({loading: false, error: {message: 'Failed to load', id: 'FAILED_TO_LOAD'}});
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

	async function indexMoreAndCatchupIfNeeded(): Promise<LastSync<ABI>> {
		await setupIndexing();
		if (!indexer) {
			throw new Error(`no indexer`);
		}

		const lastSync = await indexer.indexMore();
		setLastSync(lastSync);

		if (lastSync.lastToBlock !== lastSync.latestBlock) {
			return indexToLatest();
		}

		return lastSync;
	}

	async function indexToLatest() {
		let lastSync: LastSync<ABI> = await setupIndexing();
		setLastSync(lastSync);
		if (!indexer) {
			throw new Error(`no indexer`);
		}

		setSyncing({catchingUp: true});
		try {
			lastSync = await indexer.indexMore();
			setLastSync(lastSync);
		} catch (err) {
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

		while (lastSync.lastToBlock !== lastSync.latestBlock) {
			try {
				lastSync = await indexer.indexMore();
				setLastSync(lastSync);
			} catch (err) {
				await new Promise((resolve) => {
					setTimeout(resolve, 1000);
				});
			}
		}
		setSyncing({
			catchingUp: false,
		});
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
			const lastSync = await indexMoreAndCatchupIfNeeded();
			if (lastSync.latestBlock - lastSync.lastToBlock < 1) {
				// the latestblock fetched is smaller or equal than the last synced blocked
				// let's wait
				indexingTimeout = setTimeout(_auto_index, autoIndexingInterval * 1000);
			} else {
				// here the latestBlock is ahead, let's sync quickly again
				indexingTimeout = setTimeout(_auto_index, 1);
			}
		} catch (err) {
			namedLogger.error('ERROR, retry in 1 seconds', err);
			indexingTimeout = setTimeout(_auto_index, autoIndexingInterval * 1000);
			return;
		}
	}

	return {
		syncing: {
			subscribe: readableSyncing.subscribe,
			get $state() {
				return readableSyncing.$state;
			},
		},
		state: {
			subscribe: readableState.subscribe,
			get $state() {
				return readableState.$state;
			},
		},
		status: {
			subscribe: readableStatus.subscribe,
			get $state() {
				return readableStatus.$state;
			},
		},
		init: init as InitFunction<ABI, ProcessorConfig>,
		indexToLatest,
		indexMore,
		indexMoreAndCatchupIfNeeded,
		startAutoIndexing,
		stopAutoIndexing,
		updateProcessor(newProcessor: EventProcessorWithInitialState<ABI, ProcessResultType, ProcessorConfig>) {
			if (!indexer) {
				throw new Error(`no indexer setup, call init`);
			}
			indexer.updateProcessor(newProcessor);
		},
		updateIndexer(update: {
			provider?: EIP1193ProviderWithoutEvents;
			source?: IndexingSource<ABI>;
			streamConfig?: ProvidedStreamConfig;
		}) {
			if (!indexer) {
				throw new Error(`no indexer setup, call init`);
			}
			indexer.updateIndexer(update);
		},
		withHooks(react: ReactHooks) {
			const {useReadable} = useStores(react);
			return {
				...this,
				useState: () => useReadable(this.state, false),
				useSyncing: () => useReadable(this.syncing, false),
				useStatus: () => useReadable(this.status, false),
			};
		},
	};
}
