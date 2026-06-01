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
import {createRootStore, createStore} from './utils/stores.js';
import {ReactHooks, useStores} from 'use-stores';
import type {EIP1193ProviderWithoutEvents} from 'eip-1193';
import {formatLastSync} from './utils/format.js';
import {logs} from 'named-logs';
import {wait} from './utils/time.js';
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
	state: 'Idle' | 'Loading' | 'FetchingEventStream' | 'ProcessingEventStream' | 'CatchingUp' | 'IndexingLatest';
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
			processorConfig: ProcessorConfig,
		) => Promise<void>;

export function createIndexerState<ABI extends Abi, ProcessResultType, ProcessorConfig = undefined>(
	processor: EventProcessorWithInitialState<ABI, ProcessResultType, ProcessorConfig>,
	options?: {
		catchupThreshold?: number;
		trackNumRequests?: boolean;
		logRequests?: boolean;
		keepState?: KeepState<ABI, ProcessResultType, unknown, ProcessorConfig>;
		keepStream?: ExistingStream<ABI>;
		// Optional factory used to construct the underlying EthereumIndexer. Receives the same
		// arguments (already request-tracked/logged provider, configured processor, source, config)
		// that would otherwise be passed to `new EthereumIndexer(...)`. Useful for injecting a
		// subclass, a shared instance, or a spy/fake in tests. Defaults to `new EthereumIndexer(...)`.
		createIndexer?: (
			provider: EIP1193ProviderWithoutEvents,
			processor: EventProcessorWithInitialState<ABI, ProcessResultType, ProcessorConfig>,
			source: IndexingSource<ABI>,
			config: ProvidedIndexerConfig<ABI>,
		) => EthereumIndexer<ABI, ProcessResultType>;
	},
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

	// Serializes reconfiguration (updateIndexer/updateProcessor) so that overlapping calls
	// (e.g. a slow deploy's source change racing a processor change, in either order) run one fully
	// settled then the next, in arrival order, instead of interleaving their reset/reinit/load phases
	// on the same indexer instance.
	let reconfigureQueue: Promise<unknown> = Promise.resolve();
	function serializeReconfigure<T>(fn: () => Promise<T>): Promise<T> {
		// chain after the previous reconfigure regardless of whether it succeeded or failed
		const run = reconfigureQueue.then(fn, fn);
		// keep the chain alive even if this step rejects (so a failure does not poison the queue)
		reconfigureQueue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	async function init(
		indexerSetup: {
			provider: EIP1193ProviderWithoutEvents;
			source: IndexingSource<ABI>;
			config?: ProvidedIndexerConfig<ABI>;
		},
		processorConfig?: ProcessorConfig,
	) {
		if (indexer) {
			throw new Error(`already initialised`);
		}
		const config = {...{}, keepStream: options?.keepStream, ...(indexerSetup.config || {})};
		const source = indexerSetup.source;

		let provider: EIP1193ProviderWithoutEvents = indexerSetup.provider;

		if (options?.trackNumRequests && !options.logRequests) {
			// only trackNumRequest
			provider = new Proxy(indexerSetup.provider, {
				get(target, p, receiver) {
					if (p === 'request') {
						return (args: {method: string; params?: readonly unknown[]}) => {
							if (options.trackNumRequests) {
								setSyncing({numRequests: ($syncing.numRequests || 0) + 1});
							}
							return target[p](args as any);
						};
					}
					return (target as any)[p];
				},
			});
		} else if (options?.logRequests) {
			provider = new Proxy(indexerSetup.provider, {
				get(target, p, receiver) {
					if (p === 'request') {
						return async (args: {method: string; params?: readonly unknown[]}) => {
							if (options.trackNumRequests) {
								setSyncing({numRequests: ($syncing.numRequests || 0) + 1});
							}
							if (options.logRequests) {
								console.log(JSON.stringify(args));
							}
							let response;
							try {
								response = await target[p](args as any);
								console.log(`  =>`, JSON.stringify(response));
							} catch (err) {
								console.error(`  error:`, err);
								throw err;
							}
							return response;
						};
					}
					return (target as any)[p];
				},
			});
		}

		if (processor.configure && processorConfig) {
			processor.configure(processorConfig);
		}
		indexer = options?.createIndexer
			? options.createIndexer(provider, processor, source, config)
			: new EthereumIndexer<ABI, ProcessResultType>(provider, processor, source, config);
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

	// Clears the browser-layer syncing state that gates `setupIndexing` (its early-return on
	// `$syncing.lastSync`) so that after a reconfiguration (updateIndexer/updateProcessor) the next
	// indexMore/auto-index re-runs setupIndexing cleanly against the new source/config and recomputes
	// progress against the (possibly new) defaultFromBlock.
	function clearSyncingStateForReconfigure() {
		setSyncing({lastSync: undefined});
		// NOTE: we intentionally do NOT touch `status` here.
		// - If indexing resumes (auto-index tick or a manual indexMore), the next setupIndexing() ->
		//   load() emits `Loading` (and onward) via onLoad, so the status corrects itself.
		// - If nothing is called after the reconfigure, the indexer really is idle now (lastSync is
		//   undefined), so arguably `Idle` would be the most correct resting status. We avoid forcing
		//   either `Loading` (a lie if no reload follows, e.g. a no-reset updateIndexer) or `Idle` (a
		//   flicker if a reload does follow) and let the actual next operation set the truthful status.
	}

	async function setupIndexing(): Promise<LastSync<ABI>> {
		if ($syncing.lastSync) {
			return $syncing.lastSync;
		}
		if (!indexer) {
			throw new Error(`no indexer`);
		}
		indexer.onLoad = async (loadingState) => {
			if (loadingState === 'Loading') {
				setStatus({state: 'Loading'});
			} else if (loadingState === 'FetchingEventStream') {
				setSyncing({fetchingLogs: true});
				setStatus({state: 'FetchingEventStream'});
			} else if (loadingState === 'ProcessingEventStream') {
				setSyncing({fetchingLogs: false, processingFetchedLogs: true});
				setStatus({state: 'ProcessingEventStream'});
			} else if (loadingState === 'Loaded') {
				setSyncing({processingFetchedLogs: false});
				setSyncing({catchingUp: true});
				setStatus({state: 'CatchingUp'});
			}
			await wait(0.001); // allow propagation if the whole proces is synchronous
		};
		indexer.onLastSyncUpdated = (lastSync) => {
			// should we also wait ?
			setLastSync(lastSync);
			setCatchup(lastSync);
		};
		indexer.onStateUpdated = (state) => {
			setState(state);
		};

		setSyncing({loading: true});
		try {
			const lastSync = await indexer.load();
			setSyncing({loading: false});
			return lastSync;
		} catch (err) {
			setSyncing({loading: false, error: {message: 'Failed to load', id: 'FAILED_TO_LOAD'}});
			throw err;
		}
	}

	async function indexMore(): Promise<LastSync<ABI>> {
		await setupIndexing();
		if (!indexer) {
			throw new Error(`no indexer`);
		}
		const lastSync = await indexer.indexMore();
		setLastSync(lastSync);
		setCatchup(lastSync);
		return lastSync;
	}

	async function indexMoreAndCatchupIfNeeded(): Promise<LastSync<ABI>> {
		await setupIndexing();
		if (!indexer) {
			throw new Error(`no indexer`);
		}

		const lastSync = await indexer.indexMore();
		setLastSync(lastSync);
		setCatchup(lastSync);

		if (lastSync.lastToBlock !== lastSync.latestBlock) {
			return indexToLatest();
		}

		return lastSync;
	}

	function setCatchup(lastSync: LastSync<ABI>) {
		if (lastSync.latestBlock - lastSync.lastToBlock > (options?.catchupThreshold || 20)) {
			if (!$syncing.catchingUp) {
				setSyncing({catchingUp: true});
				setStatus({state: 'CatchingUp'});
			}
		} else {
			if ($syncing.catchingUp) {
				setSyncing({catchingUp: false});
				setStatus({state: 'IndexingLatest'});
			}
		}
	}

	async function indexToLatest() {
		let lastSync: LastSync<ABI> = await setupIndexing();
		setLastSync(lastSync);
		setCatchup(lastSync);
		if (!indexer) {
			throw new Error(`no indexer`);
		}

		try {
			lastSync = await indexer.indexMore();
			setLastSync(lastSync);
			setCatchup(lastSync);
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
				setCatchup(lastSync);
			} catch (err) {
				await new Promise((resolve) => {
					setTimeout(resolve, 1000);
				});
			}
		}

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

	function reset() {
		if (!indexer) {
			throw new Error(`no indexer`);
		}
		return indexer.reset();
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
		reset,
		updateProcessor(
			newProcessor: EventProcessorWithInitialState<ABI, ProcessResultType, ProcessorConfig>,
			options?: {force?: boolean},
		) {
			if (!indexer) {
				throw new Error(`no indexer setup, call init`);
			}
			// Serialize against any other in-flight reconfigure so overlapping update* calls do not
			// interleave their reset/reinit/load phases.
			return serializeReconfigure(async () => {
				if (!indexer) {
					throw new Error(`no indexer setup, call init`);
				}
				// Pause the auto-index loop so a timer tick cannot race the core reinit
				// (which would throw `Blocked` and trigger noisy retries). Resume after.
				const wasAutoIndexing = $syncing.autoIndexing;
				if (wasAutoIndexing) {
					stopAutoIndexing();
				}
				try {
					await indexer.updateProcessor(newProcessor, options);
					// On success only (option b): clear stale syncing state so setupIndexing() re-runs.
					// Must run before resuming auto-indexing so the resumed loop does not early-return
					// on the stale lastSync.
					clearSyncingStateForReconfigure();
				} catch (err) {
					setSyncing({error: {message: 'Failed to update processor', id: 'FAILED_TO_UPDATE_PROCESSOR'}});
					throw err;
				} finally {
					if (wasAutoIndexing) {
						await startAutoIndexing(autoIndexingInterval);
					}
				}
			});
		},
		updateIndexer(update: {
			provider?: EIP1193ProviderWithoutEvents;
			source?: IndexingSource<ABI>;
			streamConfig?: ProvidedStreamConfig;
		}) {
			if (!indexer) {
				throw new Error(`no indexer setup, call init`);
			}
			// Serialize against any other in-flight reconfigure so overlapping update* calls do not
			// interleave their reset/reinit/load phases.
			return serializeReconfigure(async () => {
				if (!indexer) {
					throw new Error(`no indexer setup, call init`);
				}
				// Pause the auto-index loop so a timer tick cannot race the core reinit
				// (which would throw `Blocked` and trigger noisy retries). Resume after.
				const wasAutoIndexing = $syncing.autoIndexing;
				if (wasAutoIndexing) {
					stopAutoIndexing();
				}
				try {
					await indexer.updateIndexer(update);
					// On success only (option b): clear stale syncing state so setupIndexing() re-runs
					// cleanly for the new source/config instead of early-returning with old progress.
					// Must run before resuming auto-indexing.
					clearSyncingStateForReconfigure();
				} catch (err) {
					setSyncing({error: {message: 'Failed to update indexer', id: 'FAILED_TO_UPDATE_INDEXER'}});
					throw err;
				} finally {
					if (wasAutoIndexing) {
						await startAutoIndexing(autoIndexingInterval);
					}
				}
			});
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
