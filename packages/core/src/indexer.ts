import {getBlockNumber, LogTransactionData} from './internal/engine/ethereum.js';
import {
	blockFetcherFor,
	enrichEvents,
	transactionFetcherFor,
	type BlockTimestampCache,
} from './internal/engine/enrich.js';

import {EIP1193ProviderWithoutEvents} from 'eip-1193';

import {logs} from 'named-logs';
import type {
	IndexingSource,
	EventProcessor,
	ProvidedIndexerConfig,
	UsedIndexerConfig,
	LastSync,
	ContextIdentifier,
	ProcessorDriftReport,
	ProvidedStreamConfig,
	SourceHashEntry,
	UsedStreamConfig,
	LogEvent,
} from './types.js';
import {LogEventFetcher} from './internal/decoding/LogEventFetcher.js';
import type {Abi} from 'abitype';
import {
	defaultFromBlockOf,
	generateStreamFromReplay,
	generateStreamToAppend,
	getFromBlock,
	groupStreamPerBlock,
	resolveStreamConfig,
	sourceInvalidationOf,
	stateMatches,
	streamMatches,
	type SourceInvalidation,
	wait,
} from './internal/engine/utils.js';
import {sourceHashesOf} from './internal/engine/eventRanges.js';
import {CancelOperations, createAction} from './internal/utils/promises.js';
import {InvalidBatchError, isOutOfSpace} from './errors.js';
import {simple_hash} from './utils/index.js';

const namedLogger = logs('@etherfold/core');

/**
 * Whether two entries of an emission stream are the same emission.
 *
 * A log is identified by its block HASH and its index in that block -- never by
 * its block NUMBER, which a reorg reuses for a different block. The retraction
 * flag is part of the identity because retracting an event and applying it are
 * two different emissions of the same log.
 */
function sameEvent<ABI extends Abi>(a: LogEvent<ABI>, b: LogEvent<ABI>): boolean {
	return a.blockHash === b.blockHash && a.logIndex === b.logIndex && !!a.removed === !!b.removed;
}

export type LoadingState = 'Loading' | 'FetchingEventStream' | 'ProcessingEventStream' | 'Loaded';

/**
 * What one attempt to write the cached stream DID, which is what decides whether
 * the batch may be processed.
 *
 * The whole of the hole fix is in this enum being consulted: the cursor moves
 * only for an outcome that leaves the stream covering the batch.
 */
export type StreamWriteOutcome =
	/** The batch (or the part of it not already stored) is on disk. */
	| 'written'
	/** Nothing to write: no keeper, or every event of this batch is already stored. */
	| 'skipped'
	/**
	 * Not attempted, because the stream is BEHIND the state and this batch does
	 * not reach back to it: writing it would put a HOLE behind a cursor claiming
	 * to cover it, and nothing detects one afterwards.
	 */
	| 'declined'
	/** The keeper threw, and the cache has not given up yet: do not process. */
	| 'failed'
	/** The keeper threw once too often: the cache is frozen and indexing goes on without it. */
	| 'frozen';

/** Consecutive failed writes before the cache is frozen; see `streamWriteRetry`. */
const DEFAULT_STREAM_WRITE_FAILURE_LIMIT = 3;
/** Seconds between attempts while writes are failing; see `streamWriteRetry`. */
const DEFAULT_STREAM_WRITE_RETRY_DELAY = 1;

/**
 * What a reconfigure DID, for the caller that has to react to it.
 *
 * `updateProcessor`, `updateIndexer` and `reset` all end in one of two very
 * different places: the state that existed is still the state, or it was thrown
 * away and is being recomputed. Which one happened is decided HERE, from the
 * version hash and the source hashes, and it used to be decided here and told to
 * nobody.
 *
 * That silence was a live defect for any caller holding a COPY of the state --
 * which is every UI, because a store, a signal or a hook is exactly that copy.
 * `onStateUpdated` fires when a state is adopted or produced, and a discard is
 * neither: the processor's fresh, empty state is not published by anything, so
 * a subscriber kept rendering the state the core had just discarded until the
 * next event happened to arrive. When the reconfigure was a contract redeploy,
 * the next event could be a long way off, or never (a freshly redeployed
 * implementation has emitted nothing yet), and "never" means the old contract's
 * state on screen for the rest of the session.
 *
 * Reported rather than inferred, because the alternative is every caller
 * re-deriving the version-hash rule -- including `force`, including the
 * source-hash comparison -- and a caller that gets that derivation wrong fails
 * in exactly the silent direction the report exists to close.
 */
export type ReconfigureOutcome = {
	/**
	 * True when the previously computed state is GONE and a fresh one is being
	 * built. A caller holding a copy must replace it; see
	 * `createIndexerState`'s `state` store for what that looks like.
	 */
	stateDiscarded: boolean;
	/**
	 * WHAT THE SOURCE COMPARISON DECIDED, for the caller that needs more than one
	 * bit -- and `undefined` when this reconfigure asked no source question.
	 *
	 * `stateDiscarded` is that verdict collapsed into "is the fold gone", which is
	 * all the caller who only re-seeds a store needs. It cannot say which HALF
	 * died or FROM WHICH BLOCK, and those are what a caller building a new
	 * generation beside the live one decides on: an invalid STREAM half means the
	 * fetch filter moved and the logs have to come from the node again, while a
	 * stream that stands with an invalid STATE half is a new fold over logs
	 * already on disk. `invalidFromBlock` is the point the new one starts from.
	 *
	 * Present on `updateIndexer`, which is the verb that moves the source or the
	 * stream config and therefore the only one that ASKS. Absent on
	 * `updateProcessor`, which moves neither, and on `reset`, which is a discard by
	 * fiat that also CLEARS the stream -- reporting "both halves valid" there would
	 * be true of the source and read as "the stream stands" about a stream that has
	 * just been deleted.
	 *
	 * REPORTED rather than re-derived, exactly like `stateDiscarded`: a caller
	 * hashing its own source to ask the same question gets a second answer that can
	 * disagree with the one the core acted on. And it is the VERDICT, never digest
	 * inequality -- `streamDigestOf` moves when an entry is appended ABOVE the
	 * cursor, which ADR-0034 makes free.
	 */
	sourceInvalidation?: SourceInvalidation;
};

// PROPOSAL FOR STATE ANCHORS
// we can have state anchor that get provided by the processor
// these set the minimum block to start fetching from

// What about prefetch
// proposal B1
// prefetch can fetch data and store it in logs.extra param
// prefecth need to keep track of its version
// we need to add more data to lastSync
// prefetchVersion
// if version change, we discard processor
//  - and we feed with prefetch to replace the extra field on each log + we resave that along with prefetch version in lastSync
// if no version changes, we are good
// whenever we process a log we perform a prefetch that add data to log.extra

// prefetch filter capabilities
// if prefetch can filter by for example returning a specific code
// then it would be great if we slim down the size of the stream by removing from it entirely
// the issue is that a new prefetch version would mean a need for indexing from scratch again
// Need to also care of reorg but this should be trivial : event removed whose event is not found is discarded

// conclusion:
// prefetch only filter capabilities should skip the event from being passed to the processor/
// but this is not very useful as the extra data could already allow the processor to skip the event picked
// so => no filter for pre-fetch
// but we could still have filter capabilties managed by another pass/process or has part of the indexer config
// and this one would slim down the event stream

// TODO add types for logValues to get better type safety when logValues setting is set
// ExpectedEventValues extends OptionsFlags<NumberifiedLog> = DefaultExpectedValues,
/**
 * ONE GENERATION: one stream, one processor, one state.
 *
 * A **generation** is a stream plus a fold over it, and this class is exactly
 * that -- which is why it is no longer called `EthereumIndexer`. An **indexer**
 * is the CONTAINER that holds several generations and points at the one that
 * answers reads (`Indexer`, `container.ts`); `CONTEXT.md` has said so since
 * ADR-0036, and this rename is what makes the code say it too. Nothing about
 * what this class DOES changed with the name: it still fetches, still derives
 * reorgs, still drives one `EventProcessor`, and a container drives one of these
 * per generation.
 *
 * `EthereumIndexer` remains as an ALIAS to THIS class (below), so every existing
 * construction site keeps compiling and keeps meaning what it meant. The alias
 * points at the generation and never at the container: `new EthereumIndexer(provider,
 * processor, source, config)` is handed one already-constructed processor and
 * one already-constructed state, which is precisely what a container that holds
 * N generations cannot be handed.
 */
export class IndexerGeneration<ABI extends Abi, ProcessResultType = void> {
	// ------------------------------------------------------------------------------------------------------------------
	// PUBLIC VARIABLES
	// ------------------------------------------------------------------------------------------------------------------

	public readonly defaultFromBlock!: number;
	public onLoad: ((state: LoadingState) => Promise<void>) | undefined;
	public onStateUpdated: ((state: ProcessResultType) => void) | undefined;
	public onLastSyncUpdated: ((lastSync: LastSync<ABI>) => void) | undefined;
	/**
	 * Called when the processor's declared version is unchanged but its code is
	 * not: the "author edited a handler and forgot to bump `version`" case.
	 *
	 * The report is ALSO logged at error level through `named-logs`, so a host
	 * that sets nothing is never silent; this exists because a log line is hard to
	 * alert on, and routing a drift to a pager or a CI failure is a decision only
	 * the host can make. Set `strictProcessorDrift` in the config to refuse to
	 * start instead.
	 */
	public onProcessorDrift: ((report: ProcessorDriftReport) => void) | undefined;

	// ------------------------------------------------------------------------------------------------------------------
	// INTERNAL VARIABLES
	// ------------------------------------------------------------------------------------------------------------------
	protected provider!: EIP1193ProviderWithoutEvents;
	protected source!: IndexingSource<ABI>;

	protected config!: UsedIndexerConfig<ABI>;
	protected finality!: number;

	protected sourceHashes!: SourceHashEntry[];
	protected streamConfigHash!: string;

	protected logEventFetcher!: LogEventFetcher<ABI>;

	protected lastSync: LastSync<ABI> | undefined;

	/**
	 * Block timestamps already fetched, so the unconfirmed window is not re-fetched
	 * every round.
	 *
	 * Only ever populated on the fallback path, for nodes that do not put
	 * `blockTimestamp` on the log. Those nodes cost one `eth_getBlockByHash` per
	 * block, and `getFromBlock` deliberately re-scans back to
	 * `latestBlock - finality` on every round to catch reorgs, so without a cache
	 * the same unconfirmed blocks are fetched again on every single round.
	 *
	 * **Keyed by block HASH, and that is what makes it safe.** A hash uniquely
	 * determines a block, so a cached timestamp cannot become wrong: a reorged-out
	 * block's hash simply never appears again. Keying by NUMBER would be silently
	 * wrong across exactly the reorgs the re-scan exists to detect, since the same
	 * height would return the dead branch's timestamp.
	 */
	protected blockTimestampCache: BlockTimestampCache = new Map();

	/**
	 * How far the STORED stream claims to reach, as this session last saw it, or
	 * `undefined` when there is no stream (none kept, absent, or just cleared).
	 *
	 * This is the whole of the no-hole rule. A batch is a DELTA against the
	 * STATE's cursor, so it is only safe to append when the stream is at or AHEAD
	 * of that cursor: then everything between what is stored and what the batch
	 * carries is already stored. When the stream is BEHIND -- which only a frozen
	 * cache can produce -- the blocks in between were emitted to nobody, and
	 * appending would claim coverage of them forever after.
	 *
	 * Comparing the two BLOCK RANGES instead would not do: the batch's fetch range
	 * reaches back into the finality window on every cycle, so it OVERLAPS a
	 * stream the state has already run past, while the events it carries start
	 * above the gap. That is the shape a keeper-side guard cannot see, which is
	 * why this lives here.
	 */
	protected streamLastToBlock: number | undefined;

	/**
	 * The batch that IS written but that the processor has not accepted yet.
	 *
	 * The in-memory slot the deleted `streamNotYetSaved` list occupied, inverted:
	 * a high-water mark of what is written rather than a buffer of what is not,
	 * which is the honest thing to remember once the cursor can no longer run
	 * ahead of the write. A processor that throws leaves the events on disk and
	 * the cursor put, so the next cycle re-derives the same delta -- and without
	 * this the cache would grow by one duplicate copy per retry.
	 *
	 * In-memory is the right scope: it only has to survive the retry loop, and a
	 * reload is covered by the load path catching the state up to the stream.
	 */
	protected streamWrittenNotProcessed: LogEvent<ABI>[] | undefined;

	/** Consecutive failed writes, reset by any successful one. */
	protected streamWriteFailures: number = 0;

	/**
	 * The cache has failed too often and is no longer allowed to stop the indexer.
	 *
	 * FROZEN, not cleared: what is on disk is a contiguous prefix with a cursor
	 * that describes it honestly, which replays as a partial seed. Throwing it
	 * away would cost a re-fetch from the source's first block, which on a public
	 * node can be impossible.
	 */
	protected streamFrozen: boolean = false;

	/** So the decline is said once rather than once per cycle. */
	protected streamDeclineReported: boolean = false;

	protected streamWriteFailureLimit: number = DEFAULT_STREAM_WRITE_FAILURE_LIMIT;
	protected streamWriteRetryDelay: number = DEFAULT_STREAM_WRITE_RETRY_DELAY;

	// ------------------------------------------------------------------------------------------------------------------
	// ACTIONS
	// ------------------------------------------------------------------------------------------------------------------
	protected _index = createAction<LastSync<ABI>>(this.promiseToIndex.bind(this));
	protected _feed = createAction<
		LastSync<ABI>,
		{newEvents: LogEvent<ABI>[]; lastSyncFetched: LastSync<ABI>; replay?: boolean}
	>(this.promiseToFeed.bind(this));
	protected _load = createAction<LastSync<ABI>>(this.promiseToLoad.bind(this));
	protected _save = createAction<
		StreamWriteOutcome,
		{source: IndexingSource<ABI>; eventStream: LogEvent<ABI>[]; lastSync: LastSync<ABI>}
	>(this.promiseToSave.bind(this));

	// ------------------------------------------------------------------------------------------------------------------
	// CONSTRUCTOR
	// ------------------------------------------------------------------------------------------------------------------

	constructor(
		provider: EIP1193ProviderWithoutEvents,
		protected processor: EventProcessor<ABI, ProcessResultType>,
		source: IndexingSource<ABI>,
		config: ProvidedIndexerConfig<ABI> = {},
	) {
		this.reinit(provider, source, config);
	}

	reinit(provider: EIP1193ProviderWithoutEvents, source: IndexingSource<ABI>, config: ProvidedIndexerConfig<ABI>) {
		this.provider = provider;

		this.source = source;
		// One entry per event per NORMALISED live range, ordered so that an append
		// lands at the end of the list -- which is what lets an upgrade keep the
		// state AND the cached stream instead of re-fetching every block. A source
		// declaring no range still produces the single whole-source entry it always
		// did, so no existing deployment changes behaviour by upgrading.
		this.sourceHashes = sourceHashesOf(this.source);

		const streamConfig: UsedStreamConfig = resolveStreamConfig(config.stream);
		this.config = {feedBatchSize: 300, ...config, stream: streamConfig};

		this.streamConfigHash = simple_hash(this.config.stream || 'undefined');
		this.finality = this.config.stream.finality;

		// The half of the stream's IDENTITY that does not travel with each call. A
		// keeper is handed a `source` on every operation and never the config, so a
		// keeper that ADDRESSES a stream by `{filter, config}` would otherwise key
		// two configs onto one subtree -- and a generation would adopt logs the
		// invalidation verdict has already declared invalid. Here rather than at the
		// keeper's construction site because this is where the config is RESOLVED,
		// and here rather than once in the constructor because `reinit` is also what
		// a RECONFIGURE goes through: the keeper follows onto the new stream and the
		// old one is left exactly where it is.
		this.config.keepStream?.setStreamConfig?.(this.config.stream);

		this.streamWriteFailureLimit =
			this.config.streamWriteRetry?.maxConsecutiveFailures ?? DEFAULT_STREAM_WRITE_FAILURE_LIMIT;
		this.streamWriteRetryDelay = this.config.streamWriteRetry?.delaySeconds ?? DEFAULT_STREAM_WRITE_RETRY_DELAY;
		// What is on DISK is deliberately NOT forgotten here. A reconfigure that
		// keeps the state cannot have invalidated the stream (an invalid stream is
		// always an invalid state too), so the extent still describes the stream this
		// indexer is about to go on writing -- and dropping it would remove the one
		// thing that stops a frozen cache being appended to. A reconfigure that DOES
		// discard reloads, and `load` re-reads the stored cursor on both branches.

		this.logEventFetcher = new LogEventFetcher(this.provider, source.contracts, config?.fetch, config.stream?.parse);

		(this.defaultFromBlock as any) = defaultFromBlockOf(this.source);
	}

	// ------------------------------------------------------------------------------------------------------------------
	// PUBLIC INTERFACE
	// ------------------------------------------------------------------------------------------------------------------

	/**
	 * The block the next batch of logs must start at.
	 *
	 * This is the value ADR-0004 makes the RECEIVER authoritative about. A
	 * log-fetcher holds no cursor, so before it fetches it asks the side that does,
	 * and a batch starting anywhere else is refused (`feed` throws, naming this
	 * number, because `generateStreamToAppend` already enforces exactly that check
	 * internally). Exposing it is what lets the two halves be pulled apart: without
	 * it the sender would have to compute the cursor itself, which is precisely the
	 * state a stateless component must not hold.
	 *
	 * It is NOT `lastToBlock + 1`. It deliberately reaches back to
	 * `latestBlock - finality` so the unconfirmed window is re-fetched every round,
	 * which is how a reorg is detected at all.
	 *
	 * Before anything has been indexed it is the source's earliest `startBlock`.
	 */
	/**
	 * The finality depth this indexer actually runs with, defaults applied.
	 *
	 * Exposed because it is not derivable from the config a caller PASSED (that
	 * one may leave `stream.finality` unset, and `resolveStreamConfig` fills it),
	 * and because it is what bounds the unconfirmed window: a consumer reasoning
	 * about that window (`checkTxInclusion`) needs the same number this indexer
	 * used, not a second copy of the default.
	 */
	get finalityDepth(): number {
		return this.finality;
	}

	get expectedFromBlock(): number {
		if (!this.lastSync) {
			return this.defaultFromBlock;
		}
		return getFromBlock(this.lastSync, this.defaultFromBlock, this.finality);
	}

	load(): Promise<LastSync<ABI>> {
		if (this._index.executing) {
			throw new Error(`indexing... should not load`);
		}

		if (this._feed.executing) {
			throw new Error(`feeding... should not load`);
		}

		// load only once, once loaded it will return the same result
		return this._load.once();
	}

	/**
	 * Hand over a FETCH: raw logs, complete over the range the cursor asks for,
	 * carrying no verdicts of their own.
	 *
	 * Every retraction is DERIVED here, by comparing the cursor's unconfirmed
	 * window against the incoming blocks, exactly as the live path derives it --
	 * which is why a batch carrying `removed` markers is refused rather than
	 * accepted with them dropped. A stream that already knows what it took back is
	 * a REPLAY and goes through `replay()`.
	 */
	async feed(eventStream: LogEvent<ABI>[], lastSyncFetched?: LastSync<ABI>): Promise<LastSync<ABI>> {
		// we first check if this valid to be called
		if (this._index.executing) {
			throw new Error(`indexing... should not feed`);
		}

		if (this._feed.executing) {
			throw new Error(`already feeding... should not feed`);
		}

		const retracted = eventStream.find((event) => event.removed);
		if (retracted) {
			// Loud rather than silent, and this is the whole shape of the bug being
			// closed: `groupLogsPerBlock` DROPS these, so a stored stream fed through
			// here replayed both branches of a reorg as live blocks and reverted
			// nothing. The same refusal `assertWellFormed` makes on the wire, for the
			// same reason -- a fetch cannot know what was taken back.
			throw new InvalidBatchError(
				`a log at block ${retracted.blockNumber} (${retracted.blockHash}) is marked removed, so this is an ` +
					`emission STREAM and not a fetch. \`feed()\` derives every retraction from the cursor's unconfirmed ` +
					`window and would DISCARD the ones carried here. Replay a stored stream with \`replay()\`, which ` +
					`honours the verdicts it already carries.`,
			);
		}

		// we do next but as we check first that it is not executing the feed
		// we could as well say feed.ifNotExecuting
		return this._feed.next({
			newEvents: eventStream,
			lastSyncFetched: lastSyncFetched || this.freshLastSync(this.processor.getVersionHash()),
		});
	}

	/**
	 * Hand over a STORED emission stream, verdicts included.
	 *
	 * The counterpart of `feed()`, and the entry a rebuild off a cached stream
	 * takes (`promiseToLoad`, both branches). What arrives here is not a re-read of
	 * a block range: it is the sequence of applies and retractions some earlier run
	 * already decided, so the engine HONOURS it instead of recomputing it from a
	 * window a rebuild does not have. It shares `promiseToFeed`'s delivery -- the
	 * per-block batching, and the rule that every retraction goes in ONE batch --
	 * and differs only in how the stream and the new cursor are derived; see
	 * `generateStreamFromReplay`.
	 *
	 * `lastSyncStored` is the stream's OWN cursor, whose `lastFromBlock` must be
	 * the block this indexer asked the keeper for. Its `unconfirmedBlocks` is
	 * ignored and may be empty: no stream keeper stores the window (ADR-0035), and
	 * the replay rebuilds it from the stream itself.
	 */
	async replay(eventStream: LogEvent<ABI>[], lastSyncStored: LastSync<ABI>): Promise<LastSync<ABI>> {
		if (this._index.executing) {
			throw new Error(`indexing... should not replay`);
		}

		if (this._feed.executing) {
			throw new Error(`already feeding... should not replay`);
		}

		return this._feed.next({newEvents: eventStream, lastSyncFetched: lastSyncStored, replay: true});
	}

	indexMore(): Promise<LastSync<ABI>> {
		// we first check if this valid to be called

		if (this._load.executing) {
			throw new Error(`loading not complete`);
		}

		if (this._feed.executing) {
			throw new Error(`feed is not complete`);
		}

		// if we call twice in a row, it will keep merging
		return this._index.ifNotExecuting();
	}

	disableProcessing() {
		// this will stop whatever it is doing
		// except reset
		this._load.cancel();
		this._feed.cancel();
		this._index.block();
	}

	reenableProcessing() {
		this._index.unblock();
	}

	async updateIndexer(update: {
		provider?: EIP1193ProviderWithoutEvents;
		source?: IndexingSource<ABI>;
		streamConfig?: ProvidedStreamConfig;
	}): Promise<ReconfigureOutcome> {
		this.disableProcessing();
		const newConfigHash = update.streamConfig ? simple_hash(update.streamConfig) : this.streamConfigHash;

		const newSourceHashes = update.source ? sourceHashesOf(update.source) : this.sourceHashes;
		const newProvider = update.provider || this.provider;
		const oldSource = this.source;

		// The CURSOR, and not 0. Whether an appended entry can be absorbed is exactly
		// the question "does it describe blocks nothing has indexed yet", so asking it
		// against block 0 answered "yes, always" and kept state that had been derived
		// over blocks the new entry describes.
		const cursor = this.lastSync?.lastToBlock ?? 0;
		const processorVersionHash = this.processor.getVersionHash();
		const invalidation = sourceInvalidationOf(newSourceHashes, newConfigHash, cursor, {
			source: this.sourceHashes,
			config: this.streamConfigHash,
			processor: processorVersionHash,
		});
		// The STATE half, and not the stream half: what a reset discards is the fold.
		// A stream that is no longer covered is dealt with where it is read, in
		// `promiseToLoad`, so a state discard whose stream SURVIVED rebuilds from the
		// cache instead of going back to the node. Today the only action is still a
		// full discard -- but the verdict is no longer thrown away with it: it rides
		// out on `ReconfigureOutcome.sourceInvalidation`, where a caller that wants the
		// other half or the block can read them. See `InvalidationVerdict`.
		const resetNeeded = !invalidation.state.valid;

		// TODO remove, this is the responsibility of the developer to ensure it pass correct data when indexer context changes
		// for now we do a minimum check of chainId
		// if this has been updated but the source remain unchanged, then the developer must have forgot to send a different source
		if (!resetNeeded) {
			const newChainIdAsHex = await newProvider.request({method: 'eth_chainId'});
			const newChainId = parseInt(newChainIdAsHex.slice(2), 16).toString();
			if (newChainId !== oldSource.chainId) {
				throw new Error(
					`
					Connected to a different chain (chainId : ${newChainId}) than the previous indexer context (${oldSource.chainId}).
					Indexer should reset.
					Did you forget to pass some new source?
					`,
				);
			}
		} else {
			if (this.config?.logLevel && this.config.logLevel >= 1) {
				namedLogger.info(`updateIndexer: Reset needed, Indexer do not match`, {
					invalidation,
					newSourceHashes,
					newConfigHash,
					sourceHashes: this.sourceHashes,
					streamConfigHash: this.streamConfigHash,
					processorVersionHash,
				});
			}
		}

		this._feed.reset();
		this._index.reset();
		this._save.reset();
		this._load.reset();
		this.reinit(
			newProvider,
			update.source || this.source,
			update.streamConfig ? {...this.config, stream: update.streamConfig} : this.config,
		);

		if (resetNeeded) {
			await this.processor
				.reset()
				.then((v) => this.load())
				.then(() => this.reenableProcessing());
		} else {
			// The state SURVIVED a source that is not the one it was computed under, so
			// the context it carries has to say so. Leaving the old list there would
			// invalidate the state on the next reload: the appended entry would then be
			// compared against a cursor that has since moved past it, and an append that
			// cost nothing today would cost a full re-index tomorrow.
			if (this.lastSync) {
				this.lastSync.context.source = this.sourceHashes;
				this.lastSync.context.config = this.streamConfigHash;
				this._onLastSyncUpdated();
			}
			this.reenableProcessing();
		}
		return {stateDiscarded: resetNeeded, sourceInvalidation: invalidation};
	}

	async updateProcessor(
		newProcessor: EventProcessor<ABI, ProcessResultType>,
		options?: {force?: boolean},
	): Promise<ReconfigureOutcome> {
		// Align with updateIndexer: disable processing first so a racing index/feed tick cannot
		// interleave with the swap, then decide, then re-enable.
		this.disableProcessing();

		const oldProcessor = this.processor;
		const versionChanged = oldProcessor.getVersionHash() != newProcessor.getVersionHash();

		if (versionChanged || options?.force) {
			// Only swap once we have decided a change is needed; do not replace the running instance
			// on a no-op path.
			this.processor = newProcessor;
			this._feed.reset();
			this._index.reset();
			this._load.reset();

			try {
				await oldProcessor.clear().then(() => this.load());
			} finally {
				this.reenableProcessing();
			}
			return {stateDiscarded: true};
		} else {
			// Same version hash and not forced: nothing to reset/reload, so we keep the running
			// processor instance. Warn in case the developer changed the processor but forgot to bump
			// its version hash (the new instance will NOT take effect). Pass `{force: true}` to swap
			// regardless of the version hash.
			namedLogger.warn(
				`updateProcessor: new processor has the same version hash as the current one; ` +
					`the swap was skipped. If this is unexpected, bump the processor's version hash or call ` +
					`updateProcessor(newProcessor, {force: true}).`,
			);
			this.reenableProcessing();
			return {stateDiscarded: false};
		}
	}

	async reset(): Promise<ReconfigureOutcome> {
		if (this._index.executing) {
			this._index.cancel();
		}
		if (this._feed.executing) {
			this._feed.cancel();
		}
		this._load.reset();

		await this.config.keepStream?.clear(this.source);
		this.forgetStoredStream();
		await this.processor.clear().then(() => this.load());
		// Unconditional, and the only one of the three that is: `reset` IS the discard.
		return {stateDiscarded: true};
	}

	// ------------------------------------------------------------------------------------------------------------------
	// INTERNALS
	// ------------------------------------------------------------------------------------------------------------------

	protected async save(
		source: IndexingSource<ABI>,
		eventStream: LogEvent<ABI>[],
		lastSync: LastSync<ABI>,
	): Promise<StreamWriteOutcome> {
		return this._save.next({source, eventStream, lastSync});
	}

	/** There is no stream on disk any more, so nothing constrains the next write. */
	protected forgetStoredStream() {
		this.streamLastToBlock = undefined;
		this.streamWrittenNotProcessed = undefined;
		this.streamDeclineReported = false;
	}

	protected async promiseToLoad(): Promise<LastSync<ABI>> {
		const chainId = await this.provider.request({method: 'eth_chainId'});
		if (parseInt(chainId.slice(2), 16).toString() !== this.source.chainId) {
			throw new Error(
				`Connected to a different chain (chainId : ${chainId}). Expected chainId === ${this.source.chainId}`,
			);
		}
		if (this.source.genesisHash && !this.config.skipGenesisCheck) {
			const genesisBlock = await this.provider.request({method: 'eth_getBlockByNumber', params: ['earliest', false]});
			if (!genesisBlock) {
				throw new Error(`Cannot fetch genesis Hash. Expected genesisHash === ${this.source.genesisHash}`);
			} else {
				const genesisHash = genesisBlock.hash;
				if (genesisHash !== this.source.genesisHash) {
					throw new Error(
						`Connected to a different chain (genesisHash: ${genesisHash}). Expected genesisHash === ${this.source.genesisHash}`,
					);
				}
			}
		}

		let currentLastSync: LastSync<ABI> | undefined = undefined;
		await this._onLoad('Loading');
		const processorHash = this.processor.getVersionHash();
		const loaded = await this.processor.load(this.source, this.config.stream);
		if (loaded) {
			const {lastSync: loadedLastSync, state} = loaded;
			if (
				processorHash === loadedLastSync.context.processor &&
				this.stateMatches(loadedLastSync.lastToBlock, loadedLastSync.context)
			) {
				// The state is about to be ADOPTED, which is the only branch where drift can
				// matter: a differing version hash discards the state anyway (a deliberate
				// bump is never a drift), and no persisted state means nothing stale to
				// serve. Checked BEFORE adopting, so strict mode refuses without ever
				// handing the stale state to a listener.
				this.reportProcessorDriftIfAny(loadedLastSync.context, processorHash);
				currentLastSync = loadedLastSync;
				// The state is valid under the CURRENT source, so record it as such. Without
				// this an absorbed append would be re-judged on every reload against the
				// stored list it was absorbed into, and would flip to a re-index as soon as
				// the cursor passed the appended entry's own block.
				currentLastSync.context.source = this.sourceHashes;
				this._onStateUpdated(state);
			} else {
				namedLogger.info(`STATE DISCARDED AS PROCESSOR CHANGED`);
				if (this.config?.logLevel && this.config.logLevel >= 1) {
					namedLogger.info(
						`State Discarded: processor changed`,
						JSON.stringify(
							{
								sourceHashes: this.sourceHashes,
								loadedSourceHashes: loaded.lastSync.context.source,
								streamConfigHash: this.streamConfigHash,
								loadedStreamConfigHash: loaded.lastSync.context.config,
								processorHash,
								loadedProcessorHash: loadedLastSync.context.processor,
							},
							null,
							2,
						),
					);
				}
				await this.processor.clear();
			}
		}
		// if mismatch found, we get a fresh sync
		if (!currentLastSync) {
			currentLastSync = this.freshLastSync(processorHash);
			this.lastSync = currentLastSync;
			this._onLastSyncUpdated();

			// but we might have some stream still valid here
			if (this.config.keepStream) {
				await this._onLoad('FetchingEventStream');
				// we start from scratch
				const fromBlock = this.defaultFromBlock;
				const existingStreamData = await this.config.keepStream.fetchFrom(this.source, fromBlock);

				// we assume the stream is correct and start from the requested number
				if (existingStreamData) {
					const {eventStream: eventsFetched, lastSync: lastSyncFetched} = existingStreamData;
					// we assign the lastFromBlock as we fetched from that
					// NOTE save shoudl probably do it itself, really, but here we deal even if it did not
					lastSyncFetched.lastFromBlock = fromBlock;

					// the STREAM half: these are raw logs under a topic-and-address filter, so
					// they are reusable whenever that filter did not GROW -- which is what lets
					// a discarded state be rebuilt without re-fetching a block
					if (this.streamMatches(lastSyncFetched.lastToBlock, lastSyncFetched.context)) {
						// What survived is the RAW half. `args` and `eventName` are a decode some
						// earlier ABI made of those bytes, and a change can move the decode without
						// moving the fetch at all -- a renamed non-indexed parameter leaves every
						// cached log exactly right and every cached `args` filed under a key the
						// handler no longer reads. So the stream is decoded AGAIN, against the
						// source running now, before a single event reaches the processor.
						const replayable = this.logEventFetcher.reparse(eventsFetched);
						if (!replayable) {
							// a `logValues` projection dropped the raw log, so this stream cannot be
							// re-read and must not be replayed on trust
							await this.config.keepStream.clear(this.source);
							this.forgetStoredStream();
						} else {
							// we update the processorHash in case it was changed
							currentLastSync.context.processor = processorHash;
							this.streamLastToBlock = lastSyncFetched.lastToBlock;
							if (replayable.length > 0) {
								await this._onLoad('ProcessingEventStream');
								// REPLAY and not feed: this stream carries its own verdicts, and this
								// cursor is FRESH, so there is no window to derive them from. Fed as
								// a fetch, a stored reorg replayed as two live branches at one height.
								await this.replay(replayable, lastSyncFetched);
							} else {
								// A stream that holds a CURSOR and no events -- the ordinary state of a
								// deployment whose contracts have emitted nothing yet, and what an empty
								// save writes. Adopting it only as a side effect of feeding left the
								// in-memory cursor at `freshLastSync`, whose `latestBlock` is 0, so the
								// scan restarted from the start block on every reload, forever. The empty
								// WINDOW is correct rather than lossy: there are no stored events, so
								// there is nothing a reorg could retract, and the next fetch rebuilds it.
								this.lastSync = {
									context: currentLastSync.context,
									lastFromBlock: lastSyncFetched.lastFromBlock,
									lastToBlock: lastSyncFetched.lastToBlock,
									latestBlock: lastSyncFetched.latestBlock,
									unconfirmedBlocks: [],
								};
								currentLastSync = this.lastSync;
								this._onLastSyncUpdated();
							}
						}
					} else {
						await this.config.keepStream.clear(this.source);
						this.forgetStoredStream();
					}
				} else {
					await this.config.keepStream.clear(this.source);
					this.forgetStoredStream();
				}
			}
		} else {
			// BEFORE the stream is consulted, not after: feeding below moves the cursor
			// to where the stream reaches, and an assignment after the block would throw
			// that catch-up away.
			this.lastSync = currentLastSync;
			this._onLastSyncUpdated();
			if (this.config.keepStream) {
				await this._onLoad('FetchingEventStream');
				const fromBlock = getFromBlock(currentLastSync, this.defaultFromBlock, this.finality);
				// we still need to clear if it does not matches, as otherwise it will be written as if it contained all logs
				const existingStreamData = await this.config.keepStream.fetchFrom(this.source, fromBlock);
				if (existingStreamData) {
					const {eventStream: eventsFetched, lastSync: lastSyncFetched} = existingStreamData;
					// the requested `fromBlock`, assigned onto the fetched cursor exactly as the
					// discarded branch does: `generateStreamToAppend` refuses a batch whose
					// `lastFromBlock` is not the one the current cursor asks for, and the stored
					// cursor's own is whatever the last fetch used
					lastSyncFetched.lastFromBlock = fromBlock;
					if (!this.streamMatches(lastSyncFetched.lastToBlock, lastSyncFetched.context)) {
						await this.config.keepStream.clear(this.source);
						this.forgetStoredStream();
					} else {
						this.streamLastToBlock = lastSyncFetched.lastToBlock;
						if (lastSyncFetched.lastToBlock > currentLastSync.lastToBlock) {
							// The stream is AHEAD of the state, which is what the tab closing between
							// the write and the process leaves behind, and it is the benign direction
							// only because the processor catches up FROM THE CACHE. Fetching those
							// blocks from the node instead would append them to the stream a second
							// time, and the next rebuild would see every one of them twice.
							//
							// Re-decoded on the way through, like the discarded branch: the stored
							// `args` are what SOME earlier ABI made of those bytes (ADR-0034), and one
							// decoding rule for a replayed stream is better than two.
							const replayable = this.logEventFetcher.reparse(eventsFetched);
							if (!replayable) {
								await this.config.keepStream.clear(this.source);
								this.forgetStoredStream();
							} else if (replayable.length > 0) {
								await this._onLoad('ProcessingEventStream');
								// The catch-up shape of the same replay: this cursor DOES hold a
								// window, and it is what stops the events it already applied from
								// being applied a second time on the way back through.
								await this.replay(replayable, lastSyncFetched);
							}
						}
					}
				}
			}
		}
		await this._onLoad('Loaded');
		return this.lastSync;
	}

	protected async promiseToFeed(
		params: {
			newEvents: LogEvent<ABI>[];
			lastSyncFetched: LastSync<ABI>;
			/** The events are a stored STREAM carrying its own verdicts, not a fetch. */
			replay?: boolean;
		},
		{unlessCancelled}: CancelOperations,
	): Promise<LastSync<ABI>> {
		const newEvents = params.newEvents;
		const lastSyncFetched = params.lastSyncFetched;

		if (!this.lastSync) {
			this.lastSync = this.freshLastSync(this.processor.getVersionHash());
			this._onLastSyncUpdated();
		}

		const bounds = {
			newLatestBlock: lastSyncFetched.latestBlock,
			newLastToBlock: lastSyncFetched.lastToBlock,
			newLastFromBlock: lastSyncFetched.lastFromBlock,
			finality: this.finality,
		};
		// The IN direction splits on the KIND of what arrived, and only here. A fetch
		// carries no verdicts, so they are derived from the cursor's window; a stored
		// stream carries its own, so they are honoured. Routing the second through the
		// first is what made a rebuild replay a reorged history as if both branches
		// were live -- `groupLogsPerBlock` drops the `removed` events, which is right
		// for a fetch (that rule is untouched) and wrong for a replay.
		const {eventStream, newLastSync} = params.replay
			? generateStreamFromReplay(this.lastSync, this.defaultFromBlock, newEvents, bounds)
			: generateStreamToAppend(this.lastSync, this.defaultFromBlock, newEvents, bounds);

		// Retractions are delivered, not dropped. `groupLogsPerBlock` skips `removed`
		// events, which is right for logs coming in from a fetch and wrong here: this
		// stream is what the PROCESSOR consumes, and a `removed` marker is the only
		// instruction it ever gets to revert. Dropping them meant the feed path could
		// apply a reorged-out block and never take it back, so a processor fed through
		// `feed()` silently kept state derived from a dead branch, while the same
		// stream through `indexMore()` reverted correctly.
		const eventsInGroups = groupStreamPerBlock(eventStream);
		const batchSize = this.config.feedBatchSize;
		let currentLastSync = {...newLastSync};
		while (eventsInGroups.length > 0) {
			const list: LogEvent<ABI>[] = [];
			// Every retraction goes in ONE batch, whatever `feedBatchSize` says. A revert
			// is a single decision about a fork point: splitting it across two `process`
			// calls would leave the processor briefly holding half a dead branch, and a
			// processor that reverts to the lowest retracted block (rather than per
			// event) would compute that fork point from a partial view.
			while (eventsInGroups.length > 0 && eventsInGroups[0].removed) {
				list.push(...(eventsInGroups.shift() as {events: LogEvent<ABI>[]}).events);
			}
			while (eventsInGroups.length > 0 && !eventsInGroups[0].removed && list.length < batchSize) {
				const blockGroup = eventsInGroups.shift();
				if (blockGroup) {
					list.push(...blockGroup.events);
				}
			}

			if (list.length > 0) {
				// a retraction-only batch must not drag the cursor backwards
				const applied = list.filter((event) => !event.removed);
				if (applied.length > 0) {
					currentLastSync.lastToBlock = applied[applied.length - 1].blockNumber;
				}
				const outcome = await unlessCancelled(this.processor.process(list, currentLastSync));
				this.lastSync = currentLastSync;
				this._onLastSyncUpdated();

				this._onStateUpdated(outcome);

				await unlessCancelled(wait(0.001));
			}
		}
		this.lastSync = newLastSync;

		return this.lastSync;
	}

	/**
	 * Write the batch to the cached stream, and SAY what happened.
	 *
	 * It reports rather than swallows, because the caller's next move depends on
	 * it: a batch that was not written must not be processed, or the state
	 * advances past events the stream never received and the cursor claims
	 * coverage of a range whose events are simply absent.
	 *
	 * What used to be here was an in-memory list of unsaved events carried to the
	 * next save on the save action's promise CONTEXT. It never fired -- the
	 * context survives only when a save is queued onto one still in flight, and
	 * the index cycle awaits its save, so the list was empty at push time every
	 * time. It existed only to compensate for processing first; with the order
	 * flipped and the cursor held back, the next cycle re-derives those events
	 * from the same cursor, so it is redundant and it is gone.
	 */
	protected async promiseToSave(params: {
		source: IndexingSource<ABI>;
		eventStream: LogEvent<ABI>[];
		lastSync: LastSync<ABI>;
	}): Promise<StreamWriteOutcome> {
		const {eventStream, source, lastSync} = params;
		const keepStream = this.config.keepStream;
		if (!keepStream) {
			return 'skipped';
		}

		if (!this.streamCanReceive()) {
			if (!this.streamDeclineReported) {
				this.streamDeclineReported = true;
				namedLogger.error(
					`the cached stream stops here: it holds blocks up to ${this.streamLastToBlock} and the state has ` +
						`moved on to ${this.lastSync?.lastToBlock}, so appending this batch would claim coverage of blocks ` +
						`the stream never received. What is stored is a contiguous prefix and is kept as one; it is replayed ` +
						`and the remainder re-fetched the next time the state is rebuilt.`,
				);
			}
			return 'declined';
		}

		const toWrite = this.streamRemainderOf(eventStream);
		try {
			await keepStream.saveNewEvents(source, {eventStream: toWrite, lastSync});
		} catch (e) {
			return this.onStreamWriteFailed(e, source);
		}
		if (this.streamWriteFailures > 0 || this.streamFrozen) {
			namedLogger.info(`the cached stream is writable again after ${this.streamWriteFailures} failed write(s)`);
		}
		this.streamWriteFailures = 0;
		this.streamFrozen = false;
		this.streamLastToBlock = lastSync.lastToBlock;
		this.streamWrittenNotProcessed = eventStream;
		return toWrite.length === 0 && eventStream.length > 0 ? 'skipped' : 'written';
	}

	/**
	 * Whether the stream is at or AHEAD of the state, which is the only position
	 * from which an append cannot leave a hole. See `streamLastToBlock`.
	 */
	protected streamCanReceive(): boolean {
		if (this.streamLastToBlock === undefined || !this.lastSync) {
			return true;
		}
		return this.streamLastToBlock >= this.lastSync.lastToBlock;
	}

	/**
	 * The part of this batch that is not already on disk, with a retraction for
	 * anything written that the chain has since moved under.
	 *
	 * The batch handed to a save is a delta against the IN-MEMORY cursor, and that
	 * cursor only advances after `process` RETURNS -- so a processor that throws
	 * leaves its events written and the next cycle re-derives the same list plus
	 * whatever the tip has added. Appending that again would grow the cache by one
	 * duplicate copy per retry, and those duplicates would replay twice once the
	 * handler is fixed.
	 *
	 * Where the two lists DIVERGE, the chain reorged under events the processor
	 * never accepted: the state cannot retract them (it never applied them), and a
	 * replay of the stream would apply a dead branch. So they are retracted HERE,
	 * at their original block, which is exactly what the emission stream is for.
	 */
	protected streamRemainderOf(eventStream: LogEvent<ABI>[]): LogEvent<ABI>[] {
		const written = this.streamWrittenNotProcessed;
		if (!written || written.length === 0) {
			return eventStream;
		}
		let common = 0;
		while (common < written.length && common < eventStream.length && sameEvent(written[common], eventStream[common])) {
			common++;
		}
		const superseded = written.slice(common).filter((event) => !event.removed);
		const retractions = superseded.map((event) => ({...event, removed: true}) as LogEvent<ABI>);
		return [...retractions, ...eventStream.slice(common)];
	}

	/**
	 * A write that threw: count it, clear ONLY for the cause the cache itself is,
	 * and give up on the cache once it has failed too often.
	 */
	protected async onStreamWriteFailed(e: unknown, source: IndexingSource<ABI>): Promise<StreamWriteOutcome> {
		this.streamWriteFailures++;
		if (isOutOfSpace(e)) {
			// the one cause where the cache IS the problem: freezing preserves it,
			// deleting frees it
			namedLogger.error(
				`the store is out of space, so the cached stream is being cleared rather than kept: ${e}. ` +
					`Indexing continues and the stream rebuilds from here.`,
			);
			try {
				await this.config.keepStream?.clear(source);
				this.forgetStoredStream();
			} catch (clearError) {
				namedLogger.error(`could not clear the cached stream after an out-of-space write: ${clearError}`);
			}
		} else {
			namedLogger.error(
				`could not save the stream (${this.streamWriteFailures} consecutive failure(s) of ` +
					`${this.streamWriteFailureLimit}): ${e}. The batch is NOT processed and the cursor does not move, so ` +
					`the next cycle re-derives it and nothing is lost.`,
			);
		}
		if (this.streamWriteFailures >= this.streamWriteFailureLimit) {
			if (!this.streamFrozen) {
				namedLogger.error(
					`the cached stream is FROZEN after ${this.streamWriteFailures} consecutive failed writes. Indexing ` +
						`carries on WITHOUT the cache: a cache is an optimisation and must never wedge the indexer. What is ` +
						`already stored is kept as a contiguous prefix and is not cleared, so it still seeds a rebuild.`,
				);
			}
			this.streamFrozen = true;
			return 'frozen';
		}
		return 'failed';
	}

	protected async promiseToIndex({unlessCancelled}: CancelOperations): Promise<LastSync<ABI>> {
		if (!this.lastSync) {
			namedLogger.info(`load lastSync...`);
			await this.load();
		}

		// as precautious measure, we check chainId in case the provider is now pointing to a new chain
		// while this is valid use, it is important to warn the indexer as soon as possible via chainChanged event
		// and pausing the call to index until the correct chain is connected again
		const before_fetch_chainIdAsHex = await unlessCancelled(this.provider.request({method: 'eth_chainId'}));
		const before_fetch_chainId = parseInt(before_fetch_chainIdAsHex.slice(2), 16).toString();
		if (before_fetch_chainId !== this.source.chainId) {
			throw new Error(`chainId changed before fetch`);
		}

		// TODO ?
		// if (!this.config.skipGenesisCheck && this.source.genesisHash) {
		// 	// as precautious measure, we check genesisHash in case the provider is now pointing to a new chain
		// 	// while this is valid use, it is important to warn the indexer as soon as possible via chainChanged event
		// 	// and pausing the call to index until the correct chain is connected again
		// 	const before_fetch_genesisBlock = (await unlessCancelled(this.provider.request({method: 'eth_getBlockByNumber', params: ["earliest", false]})))?.hash;
		// 	if (before_fetch_genesisBlock !== this.source.genesisHash) {
		// 		throw new Error(`genesis hash changed before fetch`);
		// 	}
		// }

		const previousLastSync = this.lastSync as LastSync<ABI>;
		const {lastSync: newLastSync, eventStream} = await this.fetchLogsFromProvider(previousLastSync, unlessCancelled);

		// as precautious measure, we check chainId in case the provider is now pointing to a new chain
		const chainIdAsHex = await unlessCancelled(this.provider.request({method: 'eth_chainId'}));
		const chainId = parseInt(chainIdAsHex.slice(2), 16).toString();
		if (chainId !== this.source.chainId) {
			throw new Error(`chainId changed after fetch`);
		}

		// ----------------------------------------------------------------------------------------
		// WRITE THE STREAM FIRST, AND DO NOT PROCESS A BATCH THAT WAS NOT WRITTEN
		// ----------------------------------------------------------------------------------------
		// A cache must never be behind the thing it exists to replay into. The state
		// advances inside `process` (a processor persists its own state there), so
		// processing first and saving after means a failed save leaves the stream a
		// batch behind -- and the NEXT cycle computes its delta from the already
		// advanced cursor, so the stream's cursor jumps over a range its events never
		// received. Nothing detects that afterwards.
		const written = await unlessCancelled(this.save(this.source, eventStream, newLastSync));
		if (written === 'failed') {
			// The cycle achieves nothing and the next one tries again, which is the
			// whole recovery: nothing is lost, nothing is skipped, and the stream
			// cannot fall behind the state even by one batch. Paced, because a driver
			// that loops until the tip advances would otherwise spin hot on a store
			// that is refusing.
			await unlessCancelled(wait(this.streamWriteRetryDelay));
			// The CURSOR did not move -- the in-memory one is untouched, so the next
			// fetch asks for exactly the same range -- but the tip this cycle observed
			// is not a secret. A driver that loops until `lastToBlock` reaches
			// `latestBlock` has to keep looping rather than conclude it is done, and on
			// the very first cycle of a fresh index the stored cursor still says
			// `latestBlock: 0`. Returned as a VALUE and not assigned: `getFromBlock`
			// reads `latestBlock === 0` as "nothing indexed yet", so writing this one
			// back would drag the next fetch below the source's start block.
			return {...(this.lastSync as LastSync<ABI>), latestBlock: newLastSync.latestBlock};
		}

		// ----------------------------------------------------------------------------------------
		// MAKE THE PROCESSOR PROCESS IT
		// ----------------------------------------------------------------------------------------
		const outcome = await unlessCancelled(this.processor.process(eventStream, newLastSync));
		// accepted: the cursor is about to move past this batch, so the written
		// high-water mark has done its job
		this.streamWrittenNotProcessed = undefined;

		this.lastSync = newLastSync;
		this._onLastSyncUpdated();

		if (eventStream.length > 0) {
			// state should not be updated if there is zero events
			this._onStateUpdated(outcome);
		}

		return this.lastSync;
		// ----------------------------------------------------------------------------------------
	}

	async fetchLogsFromProvider<ABI extends Abi>(
		lastSync: LastSync<ABI>,
		unlessCancelled: <T>(p: Promise<T>) => Promise<T>,
	): Promise<{lastSync: LastSync<ABI>; eventStream: LogEvent<ABI>[]}> {
		const lastUnconfirmedBlocks = lastSync.unconfirmedBlocks;

		// ----------------------------------------------------------------------------------------
		// COMPUTE fromBlock
		// ----------------------------------------------------------------------------------------
		const fromBlock = getFromBlock(lastSync, this.defaultFromBlock, this.finality);

		// ----------------------------------------------------------------------------------------

		// ----------------------------------------------------------------------------------------
		// FETCH LOGS
		// ----------------------------------------------------------------------------------------
		const latestBlock = await unlessCancelled(getBlockNumber(this.provider));

		let toBlock = latestBlock;

		if (fromBlock > toBlock) {
			namedLogger.info(`no new block`);
			return {lastSync, eventStream: []};
		}

		const {events: eventsFetched, toBlockUsed: newToBlock} = await this.logEventFetcher.getLogEvents(
			{
				fromBlock,
				toBlock: toBlock,
			},
			unlessCancelled,
		);
		toBlock = newToBlock;

		// the timestamps and transactions the logs themselves did not carry. Shared
		// with the split shape's `LogFetcher`, which is the only other thing allowed
		// to make these calls (ADR-0003): the receiving half makes none at all.
		// `getBlocks` / `getTransactions` are passed as bound methods rather than
		// built inside, so a subclass overriding either still overrides it.
		await enrichEvents(
			eventsFetched as LogEvent<ABI>[],
			{
				streamConfig: this.config.stream,
				latestBlock,
				cache: this.blockTimestampCache,
				getBlocks: (hashes, uc) => this.getBlocks(hashes, uc),
				getTransactions: (hashes, uc) => this.getTransactions(hashes, uc),
			},
			unlessCancelled,
		);

		// ----------------------------------------------------------------------------------------
		// PROCESS THE STREAM FOR REORG
		// ----------------------------------------------------------------------------------------
		const {eventStream, newLastSync} = generateStreamToAppend(
			lastSync,
			this.defaultFromBlock,
			eventsFetched as LogEvent<ABI>[],
			{
				// TODO investigate: why need to type it here ?
				newLatestBlock: latestBlock,
				newLastToBlock: toBlock,
				newLastFromBlock: fromBlock,
				finality: this.finality,
			},
		);
		// ----------------------------------------------------------------------------------------

		return {lastSync: newLastSync, eventStream};
	}

	protected async getBlocks(
		blockHashes: string[],
		unlessCancelled: <T>(p: Promise<T>) => Promise<T>,
	): Promise<{timestamp: number}[]> {
		return blockFetcherFor(this.provider, this.config.providerSupportsETHBatch)(blockHashes, unlessCancelled);
	}

	protected async getTransactions(
		transactionHashes: string[],
		unlessCancelled: <T>(p: Promise<T>) => Promise<T>,
	): Promise<LogTransactionData[]> {
		return transactionFetcherFor(this.provider, this.config.providerSupportsETHBatch)(
			transactionHashes,
			unlessCancelled,
		);
	}

	/** Whether the persisted STATE is still a fold over what this source means. */
	protected stateMatches(lastToBlock: number, context: ContextIdentifier): boolean {
		return stateMatches(this.sourceHashes, this.streamConfigHash, lastToBlock, context);
	}

	/** Whether the cached raw log STREAM was fetched under a filter this source is still covered by. */
	protected streamMatches(lastToBlock: number, context: ContextIdentifier): boolean {
		return streamMatches(this.sourceHashes, this.streamConfigHash, lastToBlock, context);
	}

	/**
	 * Compare the fingerprint of the code that computed the persisted state with
	 * the code loaded now, and report if they differ.
	 *
	 * Either side missing means "unknown", never "drifted": a cursor written
	 * before this field existed, or a processor that cannot fingerprint itself,
	 * must not report on every boot. The stored fingerprint is deliberately NOT
	 * refreshed afterwards, because it describes the code that produced the state, so the
	 * report repeats every boot until the author bumps `version` (which discards
	 * the state) rather than going quiet after being seen once.
	 */
	protected reportProcessorDriftIfAny(context: ContextIdentifier, processorHash: string): void {
		const storedFingerprint = context.processorFingerprint;
		const currentFingerprint = this.processor.getCodeFingerprint();
		if (!storedFingerprint || !currentFingerprint || storedFingerprint === currentFingerprint) {
			return;
		}

		const message =
			`PROCESSOR DRIFT: the processor's version hash is unchanged (${processorHash}) but its handler code is not ` +
			`(state was computed by ${storedFingerprint}, running ${currentFingerprint}). ` +
			`The persisted state was computed by DIFFERENT logic and is being reused as if it were current. ` +
			`Bump the processor's \`version\` to discard and recompute it. ` +
			`If no logic changed, this is a re-minification or a transpiler change and can be ignored ` +
			`(the fingerprint is advisory and never discards state on its own).`;
		const report: ProcessorDriftReport = {processorHash, storedFingerprint, currentFingerprint, message};

		namedLogger.error(message);
		if (this.onProcessorDrift) {
			try {
				this.onProcessorDrift(report);
			} catch (err) {
				namedLogger.error(`onProcessorDrift listener threw`, err);
			}
		}
		if (this.config.strictProcessorDrift) {
			throw new Error(message);
		}
	}

	protected freshLastSync(processorHash: string): LastSync<ABI> {
		if (!this.sourceHashes || !this.streamConfigHash) {
			throw new Error(`no sourceHashes or configHash computed, please load first`);
		}
		return {
			context: {
				source: this.sourceHashes,
				config: this.streamConfigHash,
				processor: processorHash,
				// Recorded on the FRESH cursor, so that the state this run computes carries
				// the identity of the code that computed it, and the next boot has something
				// to compare against.
				processorFingerprint: this.processor.getCodeFingerprint(),
			},
			lastToBlock: 0,
			lastFromBlock: 0,
			latestBlock: 0,
			unconfirmedBlocks: [],
		};
	}

	protected _onStateUpdated(outcome: ProcessResultType) {
		if (this.onStateUpdated) {
			try {
				this.onStateUpdated(outcome);
			} catch (err) {
				namedLogger.error(`onStateUpdated listener threw`, err);
			}
		}
	}

	protected _onLastSyncUpdated() {
		if (this.lastSync && this.onLastSyncUpdated) {
			try {
				this.onLastSyncUpdated(this.lastSync);
			} catch (err) {
				namedLogger.error(`onLastSyncUpdated listener threw`, err);
			}
		}
	}

	protected async _onLoad(state: LoadingState) {
		if (this.onLoad) {
			try {
				await this.onLoad(state);
			} catch (err) {
				namedLogger.error(`onLoad listener threw`, err);
			}
		}
	}
}

/**
 * The name this class shipped under, kept pointing at the GENERATION.
 *
 * The EXPAND half of an expand -> migrate -> contract rename: the identifier is
 * read at dozens of sites across four packages, so swapping it in one commit
 * cannot leave `pnpm -r build` green. It means what it always meant -- one
 * source, one processor, one state -- and the CONTRACT batch
 * (`the-old-indexer-shape-is-deleted`) removes it once no caller reads it.
 *
 * Deliberately NOT aliased to `Indexer`, the container: re-pointing an exported
 * identifier at a different concept is the silent change this three-batch split
 * exists to avoid. Deliberately NOT marked `@deprecated` either -- nothing is
 * published (`CONTEXT.md`, Conventions), so this is internal scaffolding for one
 * refactor rather than a compatibility promise.
 */
export {IndexerGeneration as EthereumIndexer};
