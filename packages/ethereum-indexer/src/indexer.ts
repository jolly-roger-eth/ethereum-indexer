import {
	getBlockData,
	getBlockNumber,
	getBlockDataFromMultipleHashes,
	getTransactionData,
	getTransactionDataFromMultipleHashes,
	LogTransactionData,
} from './internal/engine/ethereum';

import {EIP1193Block, EIP1193DATA, EIP1193ProviderWithoutEvents} from 'eip-1193';

import {logs} from 'named-logs';
import type {
	IndexingSource,
	EventProcessor,
	ProvidedIndexerConfig,
	UsedIndexerConfig,
	LastSync,
	AllContractData,
	ContextIdentifier,
	ProvidedStreamConfig,
	UsedStreamConfig,
	LogEvent,
} from './types';
import {LogEventFetcher} from './internal/decoding/LogEventFetcher';
import type {Abi} from 'abitype';
import {generateStreamToAppend, getFromBlock, groupLogsPerBlock, wait} from './internal/engine/utils';
import {CancelOperations, createAction} from './internal/utils/promises';
import {simple_hash} from './utils';

const namedLogger = logs('ethereum-indexer');

export type LoadingState = 'Loading' | 'FetchingEventStream' | 'ProcessingEventStream' | 'Loaded';

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
export class EthereumIndexer<ABI extends Abi, ProcessResultType = void> {
	// ------------------------------------------------------------------------------------------------------------------
	// PUBLIC VARIABLES
	// ------------------------------------------------------------------------------------------------------------------

	public readonly defaultFromBlock!: number;
	public onLoad: ((state: LoadingState) => Promise<void>) | undefined;
	public onStateUpdated: ((state: ProcessResultType) => void) | undefined;
	public onLastSyncUpdated: ((lastSync: LastSync<ABI>) => void) | undefined;

	// ------------------------------------------------------------------------------------------------------------------
	// INTERNAL VARIABLES
	// ------------------------------------------------------------------------------------------------------------------
	protected provider!: EIP1193ProviderWithoutEvents;
	protected source!: IndexingSource<ABI>;

	protected config!: UsedIndexerConfig<ABI>;
	protected finality!: number;

	protected sourceHashes!: {startBlock: number; hash: string}[];
	protected streamConfigHash!: string;

	protected logEventFetcher!: LogEventFetcher<ABI>;

	protected lastSync: LastSync<ABI> | undefined;

	// ------------------------------------------------------------------------------------------------------------------
	// ACTIONS
	// ------------------------------------------------------------------------------------------------------------------
	protected _index = createAction<LastSync<ABI>>(this.promiseToIndex.bind(this));
	protected _feed = createAction<LastSync<ABI>, {newEvents: LogEvent<ABI>[]; lastSyncFetched: LastSync<ABI>}>(
		this.promiseToFeed.bind(this)
	);
	protected _load = createAction<LastSync<ABI>>(this.promiseToLoad.bind(this));
	protected _save = createAction<
		void,
		{source: IndexingSource<ABI>; eventStream: LogEvent<ABI>[]; lastSync: LastSync<ABI>},
		LogEvent<ABI>[]
	>(this.promiseToSave.bind(this));

	// ------------------------------------------------------------------------------------------------------------------
	// CONSTRUCTOR
	// ------------------------------------------------------------------------------------------------------------------

	constructor(
		provider: EIP1193ProviderWithoutEvents,
		protected processor: EventProcessor<ABI, ProcessResultType>,
		source: IndexingSource<ABI>,
		config: ProvidedIndexerConfig<ABI> = {}
	) {
		this.reinit(provider, source, config);
	}

	reinit(provider: EIP1193ProviderWithoutEvents, source: IndexingSource<ABI>, config: ProvidedIndexerConfig<ABI>) {
		this.provider = provider;

		this.source = source;
		// TODO handle history (in reverse order)
		this.sourceHashes = [{startBlock: 0, hash: simple_hash(this.source)}];

		const streamConfig: UsedStreamConfig = {finality: 17, ...(config.stream || {})};
		this.config = {feedBatchSize: 300, ...config, stream: streamConfig};

		this.streamConfigHash = simple_hash(this.config.stream || 'undefined');
		this.finality = this.config.stream.finality;

		this.logEventFetcher = new LogEventFetcher(this.provider, source.contracts, config?.fetch, config.stream?.parse);

		let fromBlockFromContracts: undefined | number;
		if (Array.isArray(this.source.contracts)) {
			for (const contractData of this.source.contracts) {
				if (contractData.startBlock) {
					if (fromBlockFromContracts === undefined || contractData.startBlock < fromBlockFromContracts) {
						fromBlockFromContracts = contractData.startBlock;
					}
				} else {
					fromBlockFromContracts = 0;
				}
			}
		} else {
			fromBlockFromContracts = (this.source.contracts as unknown as AllContractData<ABI>).startBlock || 0;
		}
		(this.defaultFromBlock as any) = fromBlockFromContracts || 0;
	}

	// ------------------------------------------------------------------------------------------------------------------
	// PUBLIC INTERFACE
	// ------------------------------------------------------------------------------------------------------------------
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

	async feed(eventStream: LogEvent<ABI>[], lastSyncFetched?: LastSync<ABI>): Promise<LastSync<ABI>> {
		// we first check if this valid to be called
		if (this._index.executing) {
			throw new Error(`indexing... should not feed`);
		}

		if (this._feed.executing) {
			throw new Error(`already feeding... should not feed`);
		}

		// we do next but as we check first that it is not executing the feed
		// we could as well say feed.ifNotExecuting
		return this._feed.next({
			newEvents: eventStream,
			lastSyncFetched: lastSyncFetched || this.freshLastSync(this.processor.getVersionHash()),
		});
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
	}) {
		this.disableProcessing();
		const newConfigHash = update.streamConfig ? simple_hash(update.streamConfig) : this.streamConfigHash;

		// TODO handle history (in reverse order)
		const newSourceHashes = update.source ? [{startBlock: 0, hash: simple_hash(update.source)}] : this.sourceHashes;
		const newProvider = update.provider || this.provider;
		const oldSource = this.source;

		const processorVersionHash = this.processor.getVersionHash();
		const resetNeeded = !indexerMatches(newSourceHashes, newConfigHash, 0, {
			source: this.sourceHashes,
			config: this.streamConfigHash,
			processor: processorVersionHash,
		});

		
		// TODO remove, this is the responsibility of the developer to ensure it pass correct data when indexer context changes
		// for now we do a minimum check of chainId
		// if this has been updated but the source remain unchanged, then the developer must have forgot to send a different source
		if (!resetNeeded) {
			const newChainIdAsHex = await newProvider.request({method: 'eth_chainId'});
			const newChainId = parseInt(newChainIdAsHex.slice(2), 16).toString();
			if (newChainId !== oldSource.chainId) {
				throw new Error(
					`
					Connected to a different chain (chainId : ${newChainId}) than the previous indexer conext (${oldSource.chainId}).
					Indexer should reset.
					Did you forget to pass some new source?
					`
				);
			}
		} else {
			if (this.config?.logLevel && this.config.logLevel >= 1) {
				console.log(`updateIndexer: Reset needed, Indexer do not match`, {
					newSourceHashes,
					newConfigHash,
					sourceHashes: this.sourceHashes,
					streamConfigHash: this.streamConfigHash,
					processorVersionHash
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
			update.streamConfig ? {...this.config, stream: update.streamConfig} : this.config
		);

		if (resetNeeded) {
			await this.processor
				.reset()
				.then((v) => this.load())
				.then(() => this.reenableProcessing());
		} else {
			this.reenableProcessing();
		}
	}

	async updateProcessor(newProcessor: EventProcessor<ABI, ProcessResultType>) {
		const oldProcessor = this.processor;
		this.processor = newProcessor;
		if (oldProcessor.getVersionHash() != newProcessor.getVersionHash()) {
			// reset should close but we need to take care of state
			if (this._index.executing) {
				this._index.cancel();
			}
			if (this._feed.executing) {
				this._feed.cancel();
			}
			this._load.reset();

			await oldProcessor.clear().then(() => this.load());
		}
	}

	async reset() {
		if (this._index.executing) {
			this._index.cancel();
		}
		if (this._feed.executing) {
			this._feed.cancel();
		}
		this._load.reset();

		await this.config.keepStream?.clear(this.source);
		await this.processor.clear().then(() => this.load());
	}

	// ------------------------------------------------------------------------------------------------------------------
	// INTERNALS
	// ------------------------------------------------------------------------------------------------------------------

	protected async save(source: IndexingSource<ABI>, eventStream: LogEvent<ABI>[], lastSync: LastSync<ABI>) {
		return this._save.next({source, eventStream, lastSync});
	}

	protected async promiseToLoad(): Promise<LastSync<ABI>> {
		const chainId = await this.provider.request({method: 'eth_chainId'});
		if (parseInt(chainId.slice(2), 16).toString() !== this.source.chainId) {
			throw new Error(
				`Connected to a different chain (chainId : ${chainId}). Expected chainId === ${this.source.chainId}`
			);
		}
		if (this.source.genesisHash && !this.config.skipGenesisCheck) {
			const genesisBlock = await this.provider.request({method: 'eth_getBlockByNumber', params: ['earliest', false]});
			if (!genesisBlock) {
				throw new Error(
					`Cannot fetch genesis Hash. Expected genesisHash === ${this.source.genesisHash}`
				);
			} else {
				const genesisHash = genesisBlock.hash;
				if (genesisHash !== this.source.genesisHash) {
					throw new Error(
						`Connected to a different chain (genesisHash: ${genesisHash}). Expected genesisHash === ${this.source.genesisHash}`
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
				this.indexerMatches(loadedLastSync.lastToBlock, loadedLastSync.context)
			) {
				currentLastSync = loadedLastSync;
				this._onStateUpdated(state);
			} else {
				namedLogger.log(`STATE DISCARDED AS PROCESSOR CHANGED`);
				if (this.config?.logLevel && this.config.logLevel >= 1) {
					console.log(`State Discarded: processor changed`, JSON.stringify({
						sourceHashes: this.sourceHashes,
						loadedSourceHashes: loaded.lastSync.context.source,
						streamConfigHash: this.streamConfigHash,
						loadedStreamConfigHash: loaded.lastSync.context.config,
						processorHash,
						loadedProcessorHash: loadedLastSync.context.processor
					}, null, 2));
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

					if (this.indexerMatches(lastSyncFetched.lastToBlock, lastSyncFetched.context)) {
						// we update the processorHash in case it was changed
						currentLastSync.context.processor = processorHash;
						if (eventsFetched.length > 0) {
							await this._onLoad('ProcessingEventStream');
							await this.feed(eventsFetched, lastSyncFetched);
						}
					} else {
						await this.config.keepStream.clear(this.source);
					}
				} else {
					await this.config.keepStream.clear(this.source);
				}
			}
		} else {
			if (this.config.keepStream) {
				// we still need to clear if it does not matches, as otherwise it will be written as if it contained all logs
				const existingStreamData = await this.config.keepStream.fetchFrom(
					this.source,
					getFromBlock(currentLastSync, this.defaultFromBlock, this.finality)
				);
				if (existingStreamData) {
					const {lastSync: lastSyncFetched} = existingStreamData;
					if (!this.indexerMatches(lastSyncFetched.lastToBlock, lastSyncFetched.context)) {
						await this.config.keepStream.clear(this.source);
					}
				}
			}
			this.lastSync = currentLastSync;
			this._onLastSyncUpdated();
		}
		await this._onLoad('Loaded');
		return this.lastSync;
	}

	protected async promiseToFeed(
		params: {
			newEvents: LogEvent<ABI>[];
			lastSyncFetched: LastSync<ABI>;
		},
		{unlessCancelled}: CancelOperations
	): Promise<LastSync<ABI>> {
		const newEvents = params.newEvents;
		const lastSyncFetched = params.lastSyncFetched;

		if (!this.lastSync) {
			this.lastSync = this.freshLastSync(this.processor.getVersionHash());
			this._onLastSyncUpdated();
		}

		const {eventStream, newLastSync} = generateStreamToAppend(this.lastSync, this.defaultFromBlock, newEvents, {
			newLatestBlock: lastSyncFetched.latestBlock,
			newLastToBlock: lastSyncFetched.lastToBlock,
			newLastFromBlock: lastSyncFetched.lastFromBlock,
			finality: this.finality,
		});

		const eventsInGroups = groupLogsPerBlock(eventStream);
		const batchSize = this.config.feedBatchSize;
		let currentLastSync = {...newLastSync};
		while (eventsInGroups.length > 0) {
			const list: LogEvent<ABI>[] = [];
			while (eventsInGroups.length > 0 && list.length < batchSize) {
				const blockGroup = eventsInGroups.shift();
				if (blockGroup) {
					list.push(...blockGroup.events);
				}
			}

			if (list.length > 0) {
				currentLastSync.lastToBlock = list[list.length - 1].blockNumber;
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

	protected async promiseToSave(params: {
		source: IndexingSource<ABI>;
		eventStream: LogEvent<ABI>[];
		lastSync: LastSync<ABI>;
	}) {
		const {eventStream, source, lastSync} = params;
		// we use the promise context to get any non-saved events
		// this work as long as this is executed synchronously
		let streamNotYetSaved = this._save.getContext();
		if (!streamNotYetSaved) {
			streamNotYetSaved = [];
			this._save.setContext(streamNotYetSaved);
		}
		streamNotYetSaved.push(...eventStream);
		try {
			await this.config.keepStream?.saveNewEvents(source, {
				eventStream: streamNotYetSaved,
				lastSync,
			});
			streamNotYetSaved.splice(0, streamNotYetSaved.length);
		} catch (e) {
			namedLogger.error(`could not save stream, ${e}`);
			// ignore error
		}
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

		// if (!this.config.skipGenesisCheck && this.source.genesisHash) {
		// 	// as precautious measure, we check genesisHash in case the provider is now pointing to a new chain
		// 	const after_fetch_genesisBlock = (await unlessCancelled(this.provider.request({method: 'eth_getBlockByNumber', params: ["earliest", false]})))?.hash;
		// 	if (after_fetch_genesisBlock !== this.source.genesisHash) {
		// 		throw new Error(`genesis hash changed after fetch`);
		// 	}
		// }

		// ----------------------------------------------------------------------------------------
		// MAKE THE PROCESSOR PROCESS IT
		// ----------------------------------------------------------------------------------------
		const outcome = await unlessCancelled(this.processor.process(eventStream, newLastSync));

		// this does not throw, but we could be stuck here ?
		// TODO timeout ?
		await this.save(this.source, eventStream, newLastSync);

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
		unlessCancelled: <T>(p: Promise<T>) => Promise<T>
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
			unlessCancelled
		);
		toBlock = newToBlock;

		const blockTimestamps: {[hash: string]: number} = {};
		const transactions: {[hash: string]: LogTransactionData} = {};
		let anyFetch = false;

		const blockHashes: string[] = [];
		const transactionHashes: string[] = [];
		let lastBlock;
		let lastTransactionHash;
		for (const event of eventsFetched) {
			let fetchTransaction = false;
			let fetchBlock = false;

			if (this.config.stream.alwaysFetchTransactions) {
				if (lastTransactionHash !== event.transactionHash) {
					fetchTransaction = true;
				}
			}

			if (this.config.stream.alwaysFetchTimestamps) {
				if (!lastBlock || event.blockNumber > lastBlock) {
					fetchBlock = true;
				}
			}

			if (fetchTransaction) {
				lastTransactionHash = event.transactionHash;
				transactionHashes.push(event.transactionHash);
			}
			if (fetchBlock) {
				lastBlock = event.blockNumber;
				blockHashes.push(event.blockHash);
			}
		}
		if (blockHashes.length > 0) {
			namedLogger.info(`fetching a batch of  ${blockHashes.length} blocks...`);
			const blocks = await this.getBlocks(blockHashes, unlessCancelled);

			namedLogger.info(`...got  ${blocks.length} blocks back`);

			for (let i = 0; i < blockHashes.length; i++) {
				blockTimestamps[blockHashes[i]] = blocks[i].timestamp;
			}
			anyFetch = true;
		}

		if (transactionHashes.length > 0) {
			namedLogger.info(`fetching a batch of ${transactionHashes.length} transactions...`);
			const transactionReceipts = await this.getTransactions(transactionHashes, unlessCancelled);

			namedLogger.info(`...got ${transactionReceipts.length} transactions back`);

			for (let i = 0; i < transactionHashes.length; i++) {
				transactions[transactionHashes[i]] = transactionReceipts[i];
			}
			anyFetch = true;
		}

		if (anyFetch) {
			for (const event of eventsFetched) {
				event.transaction = transactions[event.transactionHash];
				event.blockTimestamp = blockTimestamps[event.blockHash];
			}
		}

		// ----------------------------------------------------------------------------------------
		// PROCESS THE STREAM FOR REORG
		// ----------------------------------------------------------------------------------------
		const {eventStream, newLastSync} = generateStreamToAppend(lastSync, this.defaultFromBlock, eventsFetched as LogEvent<ABI>[], { // TODO investigate: why need to type it here ?
			newLatestBlock: latestBlock,
			newLastToBlock: toBlock,
			newLastFromBlock: fromBlock,
			finality: this.finality,
		});
		// ----------------------------------------------------------------------------------------

		return {lastSync: newLastSync, eventStream};
	}

	protected async getBlocks(
		blockHashes: string[],
		unlessCancelled: <T>(p: Promise<T>) => Promise<T>
	): Promise<{timestamp: number}[]> {
		if (this.config.providerSupportsETHBatch) {
			return getBlockDataFromMultipleHashes(this.provider, blockHashes);
		} else {
			const result = [];
			for (const blockHash of blockHashes) {
				namedLogger.info(`getting block ${blockHash}...`);
				const actualBlock = await unlessCancelled(getBlockData(this.provider, blockHash as EIP1193DATA));
				result.push(actualBlock);
			}
			return result;
		}
	}

	protected async getTransactions(
		transactionHashes: string[],
		unlessCancelled: <T>(p: Promise<T>) => Promise<T>
	): Promise<LogTransactionData[]> {
		if (this.config.providerSupportsETHBatch) {
			return getTransactionDataFromMultipleHashes(this.provider, transactionHashes);
		} else {
			const result = [];
			for (const transactionHash of transactionHashes) {
				namedLogger.info(`getting block ${transactionHash}...`);
				const tx = await unlessCancelled(getTransactionData(this.provider, transactionHash as EIP1193DATA));

				result.push(tx);
			}
			return result;
		}
	}

	protected indexerMatches(lastToBlock: number, context: ContextIdentifier): boolean {
		return indexerMatches(this.sourceHashes, this.streamConfigHash, lastToBlock, context);
	}

	protected freshLastSync(processorHash: string): LastSync<ABI> {
		if (!this.sourceHashes || !this.streamConfigHash) {
			throw new Error(`no sourceHashes or configHash computed, please load first`);
		}
		return {
			context: {source: this.sourceHashes, config: this.streamConfigHash, processor: processorHash},
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
			} catch {}
		}
	}

	protected _onLastSyncUpdated() {
		if (this.lastSync && this.onLastSyncUpdated) {
			try {
				this.onLastSyncUpdated(this.lastSync);
			} catch {}
		}
	}

	protected async _onLoad(state: LoadingState) {
		if (this.onLoad) {
			try {
				await this.onLoad(state);
			} catch {}
		}
	}
}

function indexerMatches(
	// this is the indexer settings to be applied
	indexerSourceHashes: {startBlock: number; hash: string}[],
	indexerConfigHash: string,
	// this is the stream loaded
	lastToBlock: number,
	context: ContextIdentifier
	// if they do not match the indexer will take over and restart from zero
): boolean {
	if (context.config !== indexerConfigHash) {
		return false;
	}

	for (let i = 0; i < indexerSourceHashes.length; i++) {
		const indexerSourceItem = indexerSourceHashes[i];
		const fetchedSourceItem = context.source[i];
		if (fetchedSourceItem) {
			if (indexerSourceItem.hash !== fetchedSourceItem.hash) {
				return false;
			}
		} else {
			if (indexerSourceItem.startBlock <= lastToBlock) {
				return false;
			}
		}
	}
	// no mismatch found
	return true;
}
