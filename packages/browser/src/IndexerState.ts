import type {
	Abi,
	EventProcessor,
	GenerationContext,
	GenerationId,
	GenerationRecord,
	GenerationRegistry,
	HeldGeneration,
	Indexer,
	IndexerGeneration,
	IndexingSource,
	LastSync,
	ExistingStream,
	PromotionConfig,
	UsedPromotionConfig,
	ProvidedStreamConfig,
	ProvidedIndexerConfig,
	TxInclusionQuery,
	TxInclusionVerdict,
} from '@etherfold/core';
import {
	checkTxInclusion as checkTxInclusionAgainst,
	openIndexer,
	openMemoryGenerationRegistry,
	sameGeneration,
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

/**
 * A GENERATION THAT IS NOT ANSWERING READS, and how far its fold has got.
 *
 * The FACT and the DISTANCE, and nothing beyond them. Whether a second
 * generation existing means the answers on screen should be rendered, dimmed or
 * hidden is not something this library can know: only the developer knows
 * whether their reconfigure made the old answers WRONG or merely INCOMPLETE, so
 * a library that decided would be deciding wrong half the time (story 5 of
 * `a-reconfigure-is-not-an-outage`). It reports; the app decides.
 */
export type GenerationProgress = {
	/** WHICH generation. The same record `promote` takes, so a report is actionable. */
	readonly record: GenerationRecord;
	/**
	 * Whether it FOLLOWS a stream another generation writes rather than fetching
	 * its own -- which is what the common reconfigure (a processor change) makes,
	 * and what makes it free.
	 */
	readonly follows: boolean;
	/**
	 * How far its fold has got, or `undefined` before it has loaded.
	 *
	 * Absent rather than `0`, because "it has folded nothing yet" and "it is level
	 * at block 0" are different claims and an app that dims on progress must be
	 * able to tell them apart.
	 */
	readonly lastToBlock?: number;
	/**
	 * How far BEHIND the generation that is answering reads, in blocks: `0` means
	 * level (or ahead, which `manual` allows).
	 *
	 * `undefined` when either cursor is unknown. A percentage is deliberately not
	 * reported: which span to divide by is a presentation decision (the whole
	 * chain, the catch-up, the last reconfigure), and this `lastToBlock` together
	 * with `SyncingState.lastSync` carries the numbers for any of them.
	 */
	readonly blocksBehind?: number;
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
	error?: {message: string; id: ErrorCode; code?: number};
	/**
	 * EVERY generation this indexer holds that is NOT answering reads, with how far
	 * each has caught up (story 5).
	 *
	 * Empty while there is only one generation, which is the ordinary state of an
	 * app that has not reconfigured. A generation LEAVES this list the moment the
	 * canonical pointer names it -- it is then the thing being read, not a
	 * successor to it -- and the generation the pointer moved OFF enters it, because
	 * it is retained (that is what makes moving the pointer BACK a revert) and
	 * because "a generation you could revert to exists" is the same fact reported
	 * the same way.
	 */
	nonCanonicalGenerations: readonly GenerationProgress[];
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
 * THE SHAPE of this hook: the factories that BUILD a generation, rather than one
 * already-built processor over one already-built store.
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
 * The order is `createState` then `createProcessor`, and it is the order a
 * generation's IDENTITY forces: the stream half is known from the source and the
 * stream config, and the FOLD half is the processor's own version hash, so the
 * processor has to exist before the generation can be named -- which means the
 * state cannot be keyed on the finished name. The factories are per generation
 * instead, so the caller's own closure is what distinguishes this generation's
 * store from the next one's.
 *
 * There used to be a second accepted shape -- `createIndexerState(fromEntityProcessor(p)(store))`,
 * one already-built processor over one already-built store, which meant exactly
 * one generation. It is DELETED: an indexer that holds generations cannot be
 * handed one, so keeping it would have been a second call shape that could never
 * reach what the first one is for.
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
	spec: BrowserGenerationSpec<ABI, ProcessResultType, ProcessorConfig>,
	options?: {
		catchupThreshold?: number;
		trackNumRequests?: boolean;
		logRequests?: boolean;
		keepStream?: ExistingStream<ABI>;
		/**
		 * WHEN the canonical pointer moves to a generation added beside the live one.
		 *
		 * PASSED THROUGH and never defaulted here. `on-catch-up` is the default in
		 * every runtime, and this hook deliberately does not select one of its own:
		 * the axis that would justify a browser-specific value is DEVELOPMENT versus
		 * PRODUCTION, and nothing in a browser build can detect which it is in, so a
		 * runtime default would be a guess with `immediate`'s consequences. A
		 * developer who wants their edit to answer straight away says
		 * `{promotion: {policy: 'immediate'}}`; a shipped app says nothing and gets
		 * the safe one.
		 */
		promotion?: PromotionConfig;
		// Optional factory used to construct the underlying IndexerGeneration. Receives the same
		// arguments (already request-tracked/logged provider, configured processor, source, config)
		// that would otherwise be passed to `new IndexerGeneration(...)`. Useful for injecting a
		// subclass, a shared instance, or a spy/fake in tests. Defaults to
		// `new IndexerGeneration(...)`.
		//
		// The processor arrives as the `EventProcessor` the core drives, which is all
		// `new IndexerGeneration(...)` takes. This is the container's
		// `createGeneration`: one of these is built per generation.
		createIndexer?: (
			provider: EIP1193ProviderWithoutEvents,
			processor: EventProcessor<ABI, ProcessResultType>,
			source: IndexingSource<ABI>,
			config: ProvidedIndexerConfig<ABI>,
		) => IndexerGeneration<ABI, ProcessResultType>;
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
		nonCanonicalGenerations: [],
	});

	const {set: setStatus, readable: readableStatus} = createStore<StatusState>({state: 'Idle'});
	/**
	 * There is nothing to publish until `init` has built the generation.
	 *
	 * The state is a READ HANDLE onto a store, and neither exists before the
	 * factories have been called -- which is the whole point of taking factories.
	 * `init` publishes the container's INDIRECT handle the moment it does.
	 */
	const {set: setState, readable: readableState} = createRootStore<ProcessResultType>(undefined as ProcessResultType);

	/** The container this hook drives, once `init` has opened it. */
	let indexer: Indexer<ABI, ProcessResultType> | undefined;
	// `ReturnType<typeof setTimeout>` rather than `number`: this module is browser
	// code, but its own test tooling puts node's typings in scope, and the handle is
	// only ever passed back to `clearTimeout`, which takes either.
	let indexingTimeout: ReturnType<typeof setTimeout> | undefined;
	let autoIndexingInterval: number = 4;

	/**
	 * How many times the canonical pointer has moved.
	 *
	 * Read as a STAMP across an advance, to answer "did the pointer move while that
	 * call was running?". A cycle the pointer moved in returns the cursor of the
	 * generation that was canonical when it STARTED (`Indexer.indexMore` resolves
	 * the canonical generation before its loop), and publishing that afterwards
	 * would put the RETIRED generation's cursor back into `syncing` -- undoing the
	 * container's own re-publish, and leaving `checkTxInclusion` answering from a
	 * window nothing maintains.
	 */
	let promotions = 0;

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

	/**
	 * The two factories, as the container takes them: state first, then the fold
	 * over it.
	 *
	 * Shared by `init` and `addGeneration`, so a generation added beside the live
	 * one is built exactly as the first one was -- including the read HANDLE
	 * (`stateOf`), which is what lets the container answer from a generation that
	 * has folded nothing yet, and which is what a just-promoted generation IS.
	 */
	function generationSpecFor(
		createState: BrowserGenerationSpec<ABI, ProcessResultType, ProcessorConfig>['createState'],
		createProcessor: BrowserGenerationSpec<ABI, ProcessResultType, ProcessorConfig>['createProcessor'],
		processorConfig?: ProcessorConfig,
	) {
		return {
			createState: (context: GenerationContext) => createState(context),
			createProcessor: async (state: unknown, context: GenerationContext) => {
				const built = await createProcessor(state as StateStore, context);
				if (built.configure && processorConfig) {
					built.configure(processorConfig);
				}
				return built;
			},
			stateOf: (built: EventProcessor<ABI, ProcessResultType>) =>
				(built as EntityEventProcessorLike<ABI, ProcessResultType, ProcessorConfig>).state,
		};
	}

	/**
	 * THE POINTER MOVED, so what this hook derived from the retired generation goes
	 * with it.
	 *
	 * `syncing.lastSync` is not decoration: `checkTxInclusion` answers from it, and
	 * the retired generation's unconfirmed window would report a transaction as
	 * INCLUDED that the generation now answering has not reached -- which is the
	 * double-counted optimistic update the whole verdict exists to prevent. So it is
	 * dropped here, and the container re-publishes the new canonical generation's
	 * own cursor immediately after IF it has one. Where it has none (an `immediate`
	 * promotion, which is canonical before it has caught up), nothing replaces it
	 * and `checkTxInclusion` answers `unknown` / `not-synced` -- which is the honest
	 * answer rather than a missing one.
	 */
	function onPromoted(promoted: GenerationRecord) {
		promotions++;
		clearSyncingStateForReconfigure();
		// The promoted generation is passed IN rather than read back, because this
		// fires BEFORE the container applies the move on the read path (that is the
		// whole point of the callback: a consumer drops what it derived from the
		// retired generation before it is told to re-read). Asking `indexer.canonical`
		// here would still answer with the generation being superseded, and the one
		// just promoted would be reported as a successor to itself.
		reportGenerationProgress(promoted);
	}

	/**
	 * WHICH GENERATIONS ARE NOT ANSWERING READS, and how far each has caught up.
	 *
	 * Derived from the container on demand rather than accumulated here: it already
	 * keeps every generation's cursor (the promotion trigger is a comparison
	 * between two of them), and a second copy in this hook would be a second thing
	 * to keep true across promotion, revert and drop.
	 *
	 * `canonicalNow` exists for the one caller that knows better than the container
	 * does -- see `onPromoted`.
	 */
	function reportGenerationProgress(canonicalNow?: GenerationRecord) {
		if (!indexer) {
			setSyncing({nonCanonicalGenerations: []});
			return;
		}
		const generations = indexer.generations;
		// `canonical` is a generation and never nothing: `init` opens the container with
		// a spec, and a container that could not resolve a canonical generation refuses
		// to open at all rather than holding none.
		const canonical = canonicalNow ?? indexer.canonical.record;
		const isCanonical = (record: GenerationRecord) => sameGeneration(record, canonical);
		const canonicalCursor = generations.find((generation) => isCanonical(generation.record))?.lastSync?.lastToBlock;
		setSyncing({
			nonCanonicalGenerations: generations
				.filter((generation) => !isCanonical(generation.record))
				.map((generation) => {
					const lastToBlock = generation.lastSync?.lastToBlock;
					return {
						record: generation.record,
						follows: generation.follows,
						lastToBlock,
						// floored at zero: a generation AHEAD of the canonical one (which `manual`
						// allows) is not behind by a negative number, it is not behind. The two
						// cursors are both reported for an app that needs the exact relation.
						blocksBehind:
							lastToBlock === undefined || canonicalCursor === undefined
								? undefined
								: Math.max(0, canonicalCursor - lastToBlock),
					};
				}),
		});
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

		// Build the generation here, because a generation's state and its fold are
		// this hook's to construct, not the caller's to have constructed. The registry
		// is what holds WHICH generations exist and which one is canonical.
		indexer = await openIndexer<ABI, ProcessResultType>({
			registry: spec.registry ?? (await openMemoryGenerationRegistry(BROWSER_GENERATION_CAPS)),
			provider,
			source,
			config,
			...(options?.promotion ? {promotion: options.promotion} : {}),
			generations: [generationSpecFor(spec.createState, spec.createProcessor, processorConfig)],
			createGeneration: options?.createIndexer,
		});
		indexer.onPromoted = onPromoted;
		// Published straight away, and it is the INDIRECT handle: a subscriber that
		// keeps what it is handed keeps something that follows the canonical pointer.
		setState(indexer.state);
		setSyncing({waitingForProvider: false});
		// One generation and it is canonical, so this reports nothing -- but it reports
		// nothing from the CONTAINER, rather than leaving the initial value standing
		// for a container that may have been opened over a durable registry.
		reportGenerationProgress();
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
			// A load is an advance for every generation -- for a follower it is the whole
			// re-fold of the stored stream -- so it is where a successor first has a cursor.
			reportGenerationProgress();
			return lastSync;
		} catch (err) {
			setSyncing({loading: false, error: {message: 'Failed to load', id: 'FAILED_TO_LOAD'}});
			throw err;
		}
	}

	/**
	 * ONE advance, published unless the pointer moved during it.
	 *
	 * The skip is not an optimisation: the value this returns belongs to whichever
	 * generation was canonical when the cycle started, and after a promotion that is
	 * the RETIRED one. The container publishes the new canonical generation's own
	 * cursor at the move (or publishes none, when it has none yet), and that is what
	 * `syncing` must be left holding.
	 */
	async function advanceOnce(): Promise<LastSync<ABI>> {
		if (!indexer) {
			throw new Error(`no indexer`);
		}
		const stamp = promotions;
		const lastSync = await indexer.indexMore();
		if (promotions === stamp) {
			setLastSync(lastSync);
			setCatchup(lastSync);
		}
		// Unconditionally, unlike the cursor above: this is read from the container as
		// it stands NOW, so a pointer that moved during the cycle is already accounted
		// for rather than something to skip.
		reportGenerationProgress();
		return lastSync;
	}

	async function indexMore(): Promise<LastSync<ABI>> {
		await setupIndexing();
		return advanceOnce();
	}

	async function indexMoreAndCatchupIfNeeded(): Promise<LastSync<ABI>> {
		await setupIndexing();
		if (!indexer) {
			throw new Error(`no indexer`);
		}

		const lastSync = await advanceOnce();

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
			lastSync = await advanceOnce();
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
				lastSync = await advanceOnce();
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
	 * A one-line delegation, because the CONTAINER publishes the discard
	 * (`Indexer.publishDiscard`, `@etherfold/core`): `reset` IS a discard, and the
	 * copy this hook holds goes at the same moment the fold's does, through the
	 * ordinary state notification. This hook used to fill that silence itself, back
	 * when it could be handed one already-built processor and there was no container
	 * underneath to know.
	 */
	function reset() {
		if (!indexer) {
			throw new Error(`no indexer`);
		}
		return indexer.reset();
	}

	// Tear down the indexer-state so it can be safely dropped (e.g. SPA navigation / component
	// unmount). It:
	//  1. stops the auto-index loop and clears any armed timer (otherwise the self-re-arming
	//     `setTimeout(_auto_index, ...)` keeps firing forever, holding the closure alive);
	//  2. detaches the indexer callbacks (onLoad/onLastSyncUpdated/onStateUpdated) which close over
	//     the stores, so the stores become unreachable;
	//  3. drops the indexer reference and resets the browser-layer syncing/status state.
	// It is idempotent (safe to call more than once). After dispose(), `init(...)` may be called
	// again to re-initialise — note this opens a NEW container and calls the generation factories
	// again, so how much is a fresh start is the caller's: a `createState` that hands back a store
	// it captured (which is what a hot reload wants) reuses that store and whatever it holds.
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
			indexer.onPromoted = undefined;
		}

		// 3. drop the indexer reference and reset browser-layer state so a later init() starts clean.
		indexer = undefined;
		setSyncing({
			waitingForProvider: true,
			loading: false,
			autoIndexing: false,
			catchingUp: false,
			fetchingLogs: false,
			processingFetchedLogs: false,
			lastSync: undefined,
			error: undefined,
			nonCanonicalGenerations: [],
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
		/**
		 * RECONFIGURE WITHOUT AN OUTAGE: build a generation BESIDE the live one.
		 *
		 * This is what a reconfigure is under the generation model, and it is why one
		 * is not an outage: the new generation folds alongside the canonical one,
		 * which goes on answering every read until the promotion policy moves the
		 * pointer (stories 1 and 3). A generation on the SAME stream -- a processor
		 * change, which is the common case -- fetches not one log: it re-folds the
		 * stream that is already there and then follows it (ADR-0044).
		 *
		 * Distinct from `updateProcessor`, which reconfigures the canonical generation
		 * IN PLACE and therefore still costs the discard-and-rebuild it always did.
		 *
		 * When the pointer moves is the POLICY's (`promotion`), not this call's:
		 * `on-catch-up` (the default everywhere) moves it once the new generation
		 * reaches the cursor the canonical one had, `immediate` moves it here and now,
		 * and `manual` waits for `promote`.
		 */
		addGeneration(
			generation: {
				createState: BrowserGenerationSpec<ABI, ProcessResultType, ProcessorConfig>['createState'];
				createProcessor: BrowserGenerationSpec<ABI, ProcessResultType, ProcessorConfig>['createProcessor'];
			},
			processorConfig?: ProcessorConfig,
		): Promise<HeldGeneration<ABI, ProcessResultType>> {
			if (!indexer) {
				throw new Error(`no indexer setup, call init`);
			}
			// Serialized with the reconfiguring verbs: building a generation and swapping
			// the canonical one's processor are two ways of asking for the same thing, and
			// interleaving them would run one against the other's half-applied state.
			return serializeReconfigure(async () => {
				if (!indexer) {
					throw new Error(`no indexer setup, call init`);
				}
				const held = await indexer.add(
					generationSpecFor(generation.createState, generation.createProcessor, processorConfig),
				);
				// Reported from the moment it EXISTS, before it has folded anything: an app
				// that hides its answers during a rebuild must be able to do so from the
				// reconfigure, not from the first cursor the successor happens to publish.
				// (Under `immediate` the successor is canonical already, so this reports the
				// generation it superseded instead -- which is the same fact, the other way up.)
				reportGenerationProgress();
				return held;
			});
		},
		/**
		 * MOVE THE CANONICAL POINTER by hand: forwards it promotes, backwards it
		 * REVERTS.
		 *
		 * Never gated by the promotion policy, under any of its values: the policy
		 * decides the move this library makes ON ITS OWN, and `manual` means "only when
		 * asked" rather than "never". The revert is exact and costs no re-index, because
		 * the generation it names was never touched.
		 */
		promote(id: GenerationId): Promise<GenerationRecord> {
			if (!indexer) {
				throw new Error(`no indexer setup, call init`);
			}
			return indexer.promote(id);
		},
		/** Every generation this indexer holds, in the order it built them. */
		get generations(): readonly HeldGeneration<ABI, ProcessResultType>[] {
			return indexer ? indexer.generations : [];
		},
		/** The generation that answers reads right now. */
		get canonical(): HeldGeneration<ABI, ProcessResultType> | undefined {
			return indexer ? indexer.canonical : undefined;
		},
		/**
		 * The promotion policy in force, resolved.
		 *
		 * Reported rather than re-derived, so "which value is this app running under"
		 * is answered by the container that applies it and not by a second copy of the
		 * default living here. `undefined` before `init`, because the container that
		 * holds it does not exist yet.
		 */
		get promotion(): UsedPromotionConfig | undefined {
			return indexer ? indexer.promotion : undefined;
		},
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
		 * When the core does discard, `$state` is republished at that moment rather
		 * than left holding the old value until the next event overwrites it -- a wait
		 * that used to be unbounded, since a processor swapped in against a freshly
		 * redeployed contract has nothing to replay. The CONTAINER is what does that
		 * now (`Indexer.publishDiscard`, `@etherfold/core`), so it reaches every
		 * consumer of one and not this hook's subscribers alone.
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
					const outcome = await indexer.updateProcessor(newProcessor, options);
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
					// The container publishes the discard if there was one: a new source at the
					// same address is the redeploy case, and it is the one where the stale copy
					// was most dangerous -- the state on screen was computed from the events of
					// the implementation that is no longer deployed.
					const outcome = await indexer.updateIndexer(update);
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
