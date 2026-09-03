import type {
	Abi,
	EventProcessor,
	GenerationContext,
	GenerationRegistry,
	Indexer,
	IndexingSource,
	LastSync,
	LoadingState,
	ExistingStream,
	ProvidedStreamConfig,
	ProvidedIndexerConfig,
	ReconfigureOutcome,
	TxInclusionQuery,
	TxInclusionVerdict,
} from '@etherfold/core';
import {
	checkTxInclusion as checkTxInclusionAgainst,
	IndexerGeneration,
	openIndexer,
	openMemoryGenerationRegistry,
} from '@etherfold/core';
import type {StateStore} from '@etherfold/state-store';
import {BROWSER_GENERATION_CAPS} from './storage/generation/OnIndexedDB.js';
import {createRootStore, createStore} from './utils/stores.js';
import {ReactHooks, useStores} from 'use-stores';
import type {EIP1193ProviderWithoutEvents} from 'eip-1193';
import {formatLastSync} from './utils/format.js';
import {logs} from 'named-logs';
import {wait} from './utils/time.js';
const namedLogger = logs('@etherfold/browser');

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

/**
 * What the hook needs from a deployment's processor.
 *
 * Structural rather than an import of `EntityEventProcessor`, so that
 * `@etherfold/browser` does not have to depend on one entity runtime in order to
 * type the path. `EntityEventProcessor` (`@etherfold/processor-entities`)
 * satisfies it; so would anything else that runs an entity processor against a
 * store.
 *
 * `state` is a READ HANDLE and not a state object: there is no initial state to
 * CREATE, because the state is already in the store and is read back through the
 * handle. The handle exists the moment the processor does, has stable identity,
 * and is what `load` and `process` hand back.
 *
 * There used to be a second shape here -- a `ProcessorKind` tag discriminating
 * this from the free-form `EventProcessorWithInitialState` a `KeepState` keeper
 * persisted whole. That path is gone (ADR-0037), so the tag discriminates
 * nothing and the call shape is the processor itself.
 */
export type EntityEventProcessorLike<ABI extends Abi, ProcessResultType, ProcessorConfig> = EventProcessor<
	ABI,
	ProcessResultType
> & {
	readonly state: ProcessResultType;
	configure(config: ProcessorConfig): void;
};

/**
 * THE CONTAINER SHAPE of this hook: the factories that BUILD a generation,
 * rather than one already-built processor over one already-built store.
 *
 * An indexer holds any number of **generations** -- a stream plus a fold over it
 * -- and one of them is canonical and answers every read. So it cannot be handed
 * a constructed processor and a constructed store: each generation folds into
 * its OWN state, and the container has to be able to build the next one.
 *
 * ```ts
 * const indexer = createIndexerState({
 *   createState: () => createBrowserStateStore(myProcessor.entities),
 *   createProcessor: (store) => fromEntityProcessor(myProcessor)(store),
 * });
 * ```
 *
 * This is the shape every caller in this repository is written against; the
 * one-generation shape below is what the contract batch removes.
 *
 * The order is `createState` then `createProcessor`, and it is the order a
 * generation's IDENTITY forces: the stream half is known from the source and the
 * stream config, and the FOLD half is the processor's own version hash, so the
 * processor has to exist before the generation can be named -- which means the
 * state cannot be keyed on the finished name. The factories are per generation
 * instead, so the caller's own closure is what distinguishes this generation's
 * store from the next one's.
 *
 * The old shape -- `createIndexerState(fromEntityProcessor(p)(store))` -- still
 * works and still means one generation, but nothing in this repository calls it
 * any more: `every-caller-moves-onto-the-generation-container` moved every site
 * onto the factories, and the only remaining uses are the tests that assert the
 * old shape is still ACCEPTED, which go with it when
 * `the-old-indexer-shape-is-deleted` removes it.
 */
export type BrowserGenerationSpec<ABI extends Abi, ProcessResultType, ProcessorConfig = undefined> = {
	/** Where THIS generation's state lives. Called once, before its processor. */
	createState: (context: GenerationContext) => StateStore | Promise<StateStore>;
	/** The fold, over that state. The FACTORY, not its result: its version hash NAMES the generation. */
	createProcessor: (
		state: StateStore,
		context: GenerationContext,
	) =>
		| EntityEventProcessorLike<ABI, ProcessResultType, ProcessorConfig>
		| Promise<EntityEventProcessorLike<ABI, ProcessResultType, ProcessorConfig>>;
	/**
	 * Which generations this indexer holds and which one is canonical.
	 *
	 * Defaults to a MEMORY registry under `BROWSER_GENERATION_CAPS`, because this
	 * hook knows no indexer NAME and a durable registry is addressed under one --
	 * inventing a name here would fork the discriminator the stream address
	 * already carries. A tab that holds one generation re-registers it on every
	 * boot and loses nothing by that; an app that keeps a superseded generation to
	 * move the pointer BACK to wants a durable one and passes
	 * `openGenerationRegistryOnIndexedDB(name, {dropState})`.
	 */
	registry?: GenerationRegistry;
};

/**
 * What this hook drives: one generation's engine, or the container that holds
 * several.
 *
 * Structural rather than either class, so the hook does not have to know which
 * of the two shapes built it. Every verb here means the same thing on both: on
 * the container they act on the CANONICAL generation.
 */
type IndexerEngine<ABI extends Abi, ProcessResultType> = {
	readonly defaultFromBlock: number;
	readonly finalityDepth: number;
	onLoad: ((state: LoadingState) => Promise<void>) | undefined;
	onStateUpdated: ((state: ProcessResultType) => void) | undefined;
	onLastSyncUpdated: ((lastSync: LastSync<ABI>) => void) | undefined;
	load(): Promise<LastSync<ABI>>;
	indexMore(): Promise<LastSync<ABI>>;
	reset(): Promise<ReconfigureOutcome>;
	updateIndexer(update: {
		provider?: EIP1193ProviderWithoutEvents;
		source?: IndexingSource<ABI>;
		streamConfig?: ProvidedStreamConfig;
	}): Promise<ReconfigureOutcome>;
	updateProcessor(
		newProcessor: EventProcessor<ABI, ProcessResultType>,
		options?: {force?: boolean},
	): Promise<ReconfigureOutcome>;
};

/** Which of the two accepted shapes was passed. A spec BUILDS a processor; a processor IS one. */
function isGenerationSpec<ABI extends Abi, ProcessResultType, ProcessorConfig>(
	given:
		| EntityEventProcessorLike<ABI, ProcessResultType, ProcessorConfig>
		| BrowserGenerationSpec<ABI, ProcessResultType, ProcessorConfig>,
): given is BrowserGenerationSpec<ABI, ProcessResultType, ProcessorConfig> {
	return (
		typeof (given as BrowserGenerationSpec<ABI, ProcessResultType, ProcessorConfig>).createProcessor === 'function'
	);
}

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

/**
 * The browser indexing hook.
 *
 * ```ts
 * // the state (and its cursor) live in a store the app chose, and a GENERATION
 * // builds its own: the hook is handed the factories, not their results
 * const indexer = createIndexerState({
 *   createState: () => createBrowserStateStore(myProcessor.entities),
 *   createProcessor: (store) => fromEntityProcessor(myProcessor)(store),
 * });
 * ```
 *
 * ## Where the state is persisted, and by whom
 *
 * NOT here, and not by a keeper this hook holds. The processor persists through
 * its `StateStore`, which writes the sync cursor in the SAME transaction as the
 * block it describes (ADR-0027) -- which is why the cursor lives behind the
 * storage seam at all. The invariant that buys is that a processor's state and
 * its cursor never diverge: a reader never comes back to state that has advanced
 * past its recorded position, or the reverse, however the tab died.
 *
 * This used to be one of two persistence models, the other being a `KeepState`
 * keeper that wrote `{state, lastSync}` as one blob because a blob has no
 * transaction to join. That path is deleted (ADR-0037), and with it the `kind`
 * tag that told the two apart and the `keepState` option that fed one of them.
 *
 * ## And what a RELOAD does
 *
 * The state comes back from the STORE, so how far it survives is a property of
 * the backend the application chose: versioned rows in IndexedDB (the default,
 * ADR-0024) resume from the cursor, and `@etherfold/state-store-patch` is
 * memory-only by design (ADR-0023) and starts over. That is not a defect of the
 * light store; it reports `durability: 'memory-only'` in its capabilities, which
 * the read handle exposes, so an app can learn it at startup instead of from an
 * empty tab.
 */
export function createIndexerState<ABI extends Abi, ProcessResultType, ProcessorConfig = undefined>(
	givenProcessor:
		| EntityEventProcessorLike<ABI, ProcessResultType, ProcessorConfig>
		| BrowserGenerationSpec<ABI, ProcessResultType, ProcessorConfig>,
	options?: {
		catchupThreshold?: number;
		trackNumRequests?: boolean;
		logRequests?: boolean;
		keepStream?: ExistingStream<ABI>;
		// Optional factory used to construct the underlying IndexerGeneration. Receives the same
		// arguments (already request-tracked/logged provider, configured processor, source, config)
		// that would otherwise be passed to `new IndexerGeneration(...)`. Useful for injecting a
		// subclass, a shared instance, or a spy/fake in tests. Defaults to
		// `new IndexerGeneration(...)`.
		//
		// The processor arrives as the `EventProcessor` the core drives, which is all
		// `new IndexerGeneration(...)` takes. On the container shape this is the
		// container's `createGeneration`: one of these is built per generation.
		createIndexer?: (
			provider: EIP1193ProviderWithoutEvents,
			processor: EventProcessor<ABI, ProcessResultType>,
			source: IndexingSource<ABI>,
			config: ProvidedIndexerConfig<ABI>,
		) => IndexerGeneration<ABI, ProcessResultType>;
	},
) {
	/**
	 * The CONTAINER shape, or nothing when this hook was given a processor.
	 *
	 * Both are accepted, and they differ in exactly one thing: whether this hook
	 * BUILDS the generation (state then processor, at `init`) or is handed one
	 * already built. Everything after `init` is the same on both paths, which is
	 * why the engine below is structural.
	 */
	const spec = isGenerationSpec(givenProcessor) ? givenProcessor : undefined;
	// `let`, because `updateProcessor` replaces it -- and because on the container
	// shape the processor does not exist until `init` builds the generation. It used
	// to be `const`, and the hook consequently went on describing the processor it
	// no longer drove.
	let selected: EntityEventProcessorLike<ABI, ProcessResultType, ProcessorConfig> | undefined = spec
		? undefined
		: (givenProcessor as EntityEventProcessorLike<ABI, ProcessResultType, ProcessorConfig>);
	// The object the core is handed at `init`. It is the one `selected` names at
	// construction, and it stays that object for the life of the underlying
	// indexer: `updateProcessor` hands the NEW one to the core directly and
	// re-points `selected`, so the two are only ever the same before a swap.
	const processor = selected;
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

	/**
	 * How many times the core has published a state.
	 *
	 * Read ONLY as a comparison across a reconfigure, to answer "did the core
	 * produce a state while that call was running?". A reconfigure that discards
	 * does not always end with nothing: when a kept STREAM is still valid (a
	 * processor swap leaves the cached events untouched, since the STREAM verdict
	 * is about the source and the config and not the processor), `load` replays it
	 * and publishes the REBUILT state before the call returns. Re-seeding after
	 * that would throw away the very thing the rebuild produced.
	 */
	let statePublications = 0;

	/**
	 * The state to publish when there is nothing computed yet.
	 *
	 * It is the processor's READ HANDLE: there is nothing to create, because the
	 * state is rows in a store and the handle onto them exists the moment the
	 * processor does.
	 *
	 * Called at construction and again after a reconfigure that DISCARDED the
	 * state, which are the same situation: a processor that has processed nothing.
	 * One expression for both, so the value a subscriber sees before the first
	 * event cannot depend on how it got here.
	 */
	function emptyStateOf(current: EntityEventProcessorLike<ABI, ProcessResultType, ProcessorConfig>): ProcessResultType {
		return current.state;
	}

	/**
	 * The same question on the container shape: the INDIRECT handle.
	 *
	 * It resolves to whichever generation is canonical, so publishing it here is
	 * what makes a handle a subscriber kept across a pointer move go on answering
	 * -- from the generation that is canonical NOW rather than the one that was.
	 * Before `init` there is no generation and therefore nothing to read.
	 */
	function currentEmptyState(): ProcessResultType {
		if (container) {
			return container.state;
		}
		return emptyStateOf(selected as EntityEventProcessorLike<ABI, ProcessResultType, ProcessorConfig>);
	}

	const initialState = selected ? emptyStateOf(selected) : (undefined as ProcessResultType);

	const {set: setStatus, readable: readableStatus} = createStore<StatusState>({state: 'Idle'});
	const {set: setState, readable: readableState} = createRootStore<ProcessResultType>(initialState);

	let indexer: IndexerEngine<ABI, ProcessResultType> | undefined;
	/** The container, on the container shape only. `indexer` IS this one then. */
	let container: Indexer<ABI, ProcessResultType> | undefined;
	// `ReturnType<typeof setTimeout>` rather than `number`: this module is browser
	// code, but its own test tooling puts node's typings in scope, and the handle is
	// only ever passed back to `clearTimeout`, which takes either.
	let indexingTimeout: ReturnType<typeof setTimeout> | undefined;
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

		if (spec) {
			// The CONTAINER shape: build the generation here, because a generation's
			// state and its fold are this hook's to construct now, not the caller's to
			// have constructed. The registry is what holds WHICH generations exist and
			// which one is canonical.
			container = await openIndexer<ABI, ProcessResultType>({
				registry: spec.registry ?? (await openMemoryGenerationRegistry(BROWSER_GENERATION_CAPS)),
				provider,
				source,
				config,
				generations: [
					{
						createState: (context) => spec.createState(context),
						createProcessor: async (state, context) => {
							const built = await spec.createProcessor(state as StateStore, context);
							if (built.configure && processorConfig) {
								built.configure(processorConfig);
							}
							// This is now the processor the hook describes, exactly as the
							// given one is on the other shape.
							selected = built;
							return built;
						},
						// The entity path's state is a read HANDLE that exists the moment the
						// processor does, so the container can answer from a generation that
						// has folded nothing -- which is what a just-promoted generation is.
						stateOf: (built) => (built as EntityEventProcessorLike<ABI, ProcessResultType, ProcessorConfig>).state,
					},
				],
				createGeneration: options?.createIndexer,
			});
			indexer = container;
			// Published straight away, and it is the INDIRECT handle: a subscriber that
			// keeps what it is handed keeps something that follows the canonical pointer.
			setState(container.state);
		} else {
			const given = processor as EntityEventProcessorLike<ABI, ProcessResultType, ProcessorConfig>;
			if (given.configure && processorConfig) {
				given.configure(processorConfig);
			}
			indexer = options?.createIndexer
				? options.createIndexer(provider, given, source, config)
				: new IndexerGeneration<ABI, ProcessResultType>(provider, given, source, config);
		}
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
			statePublications++;
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

	/**
	 * Throw the computed state away and rebuild it from the start block.
	 *
	 * The re-seed is the whole reason this is not a one-line delegation: `reset` IS
	 * a discard, so the copy this hook publishes has to go at the same moment the
	 * processor's does. Without it a subscriber keeps rendering the state that was
	 * just reset until the next event arrives to overwrite it -- and on a chain
	 * with nothing left to replay, that is never.
	 */
	async function reset() {
		if (!indexer) {
			throw new Error(`no indexer`);
		}
		const publishedBefore = statePublications;
		const outcome = await indexer.reset();
		if (outcome.stateDiscarded && statePublications === publishedBefore) {
			setState(currentEmptyState());
		}
		return outcome;
	}

	// Tear down the indexer-state so it can be safely dropped (e.g. SPA navigation / component
	// unmount). It:
	//  1. stops the auto-index loop and clears any armed timer (otherwise the self-re-arming
	//     `setTimeout(_auto_index, ...)` keeps firing forever, holding the closure alive);
	//  2. detaches the indexer callbacks (onLoad/onLastSyncUpdated/onStateUpdated) which close over
	//     the stores, so the stores become unreachable;
	//  3. drops the indexer reference and resets the browser-layer syncing/status state.
	// It is idempotent (safe to call more than once). After dispose(), `init(...)` may be called
	// again to re-initialise — note this reuses the SAME stores and processor instance (the
	// processor keeps whatever internal state it had); it is not a full fresh start of those.
	function dispose() {
		// 1. stop auto-indexing and unconditionally clear the timer (a tick may have armed it).
		stopAutoIndexing();
		if (indexingTimeout) {
			clearTimeout(indexingTimeout);
			indexingTimeout = undefined;
		}

		// 2. detach callbacks that close over the stores.
		if (indexer) {
			indexer.onLoad = undefined;
			indexer.onLastSyncUpdated = undefined;
			indexer.onStateUpdated = undefined;
		}

		// 3. drop the indexer reference and reset browser-layer state so a later init() starts clean.
		indexer = undefined;
		container = undefined;
		setSyncing({
			waitingForProvider: true,
			loading: false,
			autoIndexing: false,
			catchingUp: false,
			fetchingLogs: false,
			processingFetchedLogs: false,
			lastSync: undefined,
			error: undefined,
		});
		setStatus({state: 'Idle'});
	}

	/**
	 * Does the state in `$state` already account for these transactions?
	 *
	 * The reconciliation an app needs before it lays an optimistic update over
	 * indexed state: applied twice, a non-idempotent update (a counter, a balance,
	 * an append) is wrong. See `checkTxInclusion` in `@etherfold/core` for what the
	 * verdicts mean, why the caller's own receipt cannot answer this, and what it
	 * cannot tell you.
	 *
	 * Answered against the CURRENT cursor and the indexer's own configured finality
	 * depth, so a caller never has to keep a second copy of either. The pairing with
	 * `$state` is close but not transactional: the core writes the state through the
	 * processor BEFORE it publishes the cursor, and this hook then sets `syncing`
	 * before `state`, so within one synchronous update the cursor can be one
	 * statement ahead of the `state` store and never behind. That direction is the
	 * safe one -- an overlay dropped a moment early flickers, one dropped late is
	 * counted twice -- and a subscriber that reads both after the update sees them
	 * agree.
	 */
	function checkTxInclusion(queries: readonly TxInclusionQuery[]): Record<string, TxInclusionVerdict> {
		return checkTxInclusionAgainst($syncing.lastSync, queries, indexer ? indexer.finalityDepth : 0);
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
		checkTxInclusion,
		init: init as InitFunction<ABI, ProcessorConfig>,
		indexToLatest,
		indexMore,
		indexMoreAndCatchupIfNeeded,
		startAutoIndexing,
		stopAutoIndexing,
		reset,
		dispose,
		/**
		 * Swap the processor in place.
		 *
		 * It takes the same shape the hook does, so a live-reload that rebuilds a
		 * processor does not have to unwrap it by hand. The core is handed the
		 * `EventProcessor` and decides whether the state survives by comparing VERSION
		 * HASHES -- which are author-declared, so an edited handler under an unchanged
		 * `version` is not a change the core can see, and the swap is SKIPPED rather
		 * than applied. Bump the processor's `version`, or pass `{force: true}`, to
		 * make an edit take effect.
		 *
		 * When the core does discard, so does this hook: `$state` is re-seeded from the
		 * new processor at that moment rather than being left holding the old value
		 * until the next event overwrites it. That wait used to be unbounded -- a
		 * processor swapped in against a freshly redeployed contract has nothing to
		 * replay, so nothing ever arrived to correct the display.
		 */
		updateProcessor(
			newProcessor: EntityEventProcessorLike<ABI, ProcessResultType, ProcessorConfig>,
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
					const publishedBefore = statePublications;
					const outcome = await indexer.updateProcessor(newProcessor, options);
					if (outcome.stateDiscarded) {
						// The core took the new processor, so this is now the processor the hook
						// describes. Recorded unconditionally, and BEFORE any re-seed, because the
						// empty state to publish is the NEW processor's: it is a handle onto the
						// new store, which is a different store whenever the declarations
						// changed.
						selected = newProcessor;
						// ...but only when the discard really did leave nothing. If a kept stream
						// was replayed during `load`, the rebuilt state is already published and is
						// the truth; blanking it here would undo the rebuild.
						if (statePublications === publishedBefore) {
							setState(currentEmptyState());
						}
					}
					// On success only (option b): clear stale syncing state so setupIndexing() re-runs.
					// Must run before resuming auto-indexing so the resumed loop does not early-return
					// on the stale lastSync.
					clearSyncingStateForReconfigure();
					// Forwarded, not swallowed: whether the state survived is the caller's
					// decision to act on too (a hot-reload handler choosing between carrying on
					// and telling the user its data is being rebuilt).
					return outcome;
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
					const publishedBefore = statePublications;
					const outcome = await indexer.updateIndexer(update);
					if (outcome.stateDiscarded && statePublications === publishedBefore) {
						// A new source at the same address is the redeploy case, and it is the one
						// where the stale copy was most dangerous: the state on screen was computed
						// from the events of the implementation that is no longer deployed.
						setState(currentEmptyState());
					}
					// On success only (option b): clear stale syncing state so setupIndexing() re-runs
					// cleanly for the new source/config instead of early-returning with old progress.
					// Must run before resuming auto-indexing.
					clearSyncingStateForReconfigure();
					return outcome;
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
