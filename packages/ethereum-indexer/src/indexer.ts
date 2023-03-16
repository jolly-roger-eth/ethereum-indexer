import {
	getBlockData,
	getBlockNumber,
	getBlockDataFromMultipleHashes,
	getTransactionData,
	getTransactionDataFromMultipleHashes,
	LogTransactionData,
} from './engine/ethereum';

import {EIP1193DATA, EIP1193ProviderWithoutEvents} from 'eip-1193';

import {logs} from 'named-logs';
import type {
	IndexingSource,
	EventProcessor,
	IndexerConfig,
	LastSync,
	AllContractData,
	ContextIdentifier,
	ExistingStream,
	StreamConfig,
} from './types';
import {LogEvent, LogEventFetcher, ParsedLogsPromise, ParsedLogsResult} from './decoding/LogEventFetcher';
import type {Abi} from 'abitype';
import {generateStreamToAppend, getFromBlock, groupLogsPerBlock, wait} from './engine/utils';
import {hash} from './utils';

const namedLogger = logs('ethereum-indexer');

export type LoadingState = 'Loading' | 'Fetching' | 'Processing' | 'Done';

// PROPOSAL FOR STATE ANCHORS
// we can have state anchor that get provided by the processor
// these set the minimum block to start fetching from

// currently the processor dictates the refresh
// if it does not do correctly (source changes for example), then the stream has no way to kicks in

// proposal A
// we first fetch the stream
// if none, then, it is up to the processor do deal with it like before =>
// else we check the source. if it differs we ask the processor to delete all
// and we do not load

// issue is that if the stream was not saved, we have the same problem as before: processor will not know
// solution: we always ask to be saved
// proposal B
// lastSync can contains a source hash, this way it will be given by the processor too
// and so the process is as follow:
// - we load from processor like before
// - if lastSync.sourceHash differs from new sourceHash
//   - we tell processor to delete, and we discard the loaded data
//   - we start from scratch and save the new sourceHash in lastSync
// - if same, then we are fine and we keep going like now

// What about prefetch
// proposal B1
// prefetch can fetch data and store it in logs.extra param
// prefecth need to keep track of its version
// we need to add more data to lastSync
// prefetchVersion
// if version change, we discard processor data like above
//  - and we feed with prefetch to replace the extra field on each log + we resave that along with prefetch version in lastSync
// if no version changes, we are good
// whenever we process a log we perform a prefetch that add data to log.extra

// prefetch filter capabilities
// if prefetch can filter by for example returning a specific code
// then it would be great if we slim down the size of the stream by removing from it entirely and skiping the streamID
// the issue is that a new prefetch version would mean a need for indexing from scratch again
// Need to also care of reorg but this should be trivial : event removed whose event is not found is discarded

// conclusion:
// prefetch only filter capabilities should skip the event from being passed to the processor/
// but this is not very useful as the extra data could already allow the processor to skip the event picked
// so => no filter for pre-fetch
// but we could still have filter capabilties managed by another pass/process
// and this one would slim down the event stream

export class EthereumIndexer<ABI extends Abi, ProcessResultType = void> {
	// ------------------------------------------------------------------------------------------------------------------
	// PUBLIC VARIABLES
	// ------------------------------------------------------------------------------------------------------------------

	public readonly defaultFromBlock: number;
	public onLoad: ((state: LoadingState, lastSync?: LastSync<ABI>) => Promise<void>) | undefined;
	public onStateUpdated: ((state: ProcessResultType) => void) | undefined;

	// ------------------------------------------------------------------------------------------------------------------
	// INTERNAL VARIABLES
	// ------------------------------------------------------------------------------------------------------------------
	protected logEventFetcher: LogEventFetcher<ABI>;
	protected lastSync: LastSync<ABI> | undefined;
	protected finality: number;
	protected alwaysFetchTimestamps: boolean;
	protected alwaysFetchTransactions: boolean;
	protected providerSupportsETHBatch: boolean;
	protected existingStream: ExistingStream<ABI> | undefined;
	protected appendedStreamNotYetSaved: LogEvent<ABI>[] = [];
	protected _reseting: Promise<void> | undefined;
	protected _loading: Promise<LastSync<ABI>> | undefined;
	protected _indexingMore: Promise<LastSync<ABI>> | undefined;
	protected _feeding: Promise<LastSync<ABI>> | undefined;
	protected _saving: Promise<void> | undefined;
	protected _logEventPromise: ParsedLogsPromise<ABI> | undefined;

	protected sourceHashes: {startBlock: number; hash: string}[] | undefined;
	protected configHash: string | undefined;
	protected streamConfig: StreamConfig;
	// ------------------------------------------------------------------------------------------------------------------
	// CONSTRUCTOR
	// ------------------------------------------------------------------------------------------------------------------

	constructor(
		protected provider: EIP1193ProviderWithoutEvents,
		protected processor: EventProcessor<ABI, ProcessResultType>,
		protected source: IndexingSource<ABI>,
		config: IndexerConfig<ABI> = {}
	) {
		this.streamConfig = {...config.stream};
		this.finality = config.stream?.finality || 12;
		this.logEventFetcher = new LogEventFetcher(provider, source.contracts, config?.fetch, config.stream?.parse);
		this.alwaysFetchTimestamps = config.stream?.alwaysFetchTimestamps ? true : false;
		this.alwaysFetchTransactions = config.stream?.alwaysFetchTransactions ? true : false;
		this.existingStream = config.keepStream;

		this.providerSupportsETHBatch = config.providerSupportsETHBatch as boolean;

		this.defaultFromBlock = 0;
		if (Array.isArray(this.source.contracts)) {
			for (const contractData of this.source.contracts) {
				if (contractData.startBlock) {
					if (this.defaultFromBlock === 0) {
						this.defaultFromBlock = contractData.startBlock;
					} else if (contractData.startBlock < this.defaultFromBlock) {
						this.defaultFromBlock = contractData.startBlock;
					}
				}
			}
		} else {
			this.defaultFromBlock = (this.source.contracts as unknown as AllContractData<ABI>).startBlock || 0;
		}
	}

	// ------------------------------------------------------------------------------------------------------------------
	// PUBLIC INTERFACE
	// ------------------------------------------------------------------------------------------------------------------
	load(): Promise<LastSync<ABI>> {
		if (!this._loading) {
			this._loading = this.promiseToLoad();
		}
		return this._loading;
	}

	stopProcessing() {
		this._indexingMore = undefined;
		if (this._logEventPromise) {
			// we stop pending log fetch
			this._logEventPromise.stopRetrying(); // TODO RejectablePromise instead
		}
	}

	async reset() {
		if (this._reseting) {
			return this._reseting;
		}
		if (this._loading) {
			try {
				// finish loading if any
				await this._loading;
			} catch (err) {
				// but ignore failures
			}
		}
		this._reseting = new Promise(async (resolve, reject) => {
			this._indexingMore = undefined; // abort indexing if any, see `indexMore`
			if (this._logEventPromise) {
				this._logEventPromise.stopRetrying();
			}
			this._feeding = undefined; // abort feeding if any, see `feed`
			this.lastSync = undefined;
			try {
				await this.processor.reset();
				this._reseting = undefined;
				resolve();
			} catch (err) {
				this._reseting = undefined;
				reject(err);
			}
		});
		return this._reseting;
	}

	async feed(eventStream: LogEvent<ABI>[], lastSyncFetched?: LastSync<ABI>): Promise<LastSync<ABI>> {
		if (!lastSyncFetched) {
			lastSyncFetched = this.freshLastSync(this.processor.getVersionHash());
		}
		if (this._indexingMore) {
			throw new Error(`indexing... should not feed`);
		}
		if (this._reseting) {
			throw new Error(`reseting... should not feed`);
		}

		if (this._feeding) {
			throw new Error(`already feeding... should not feed`);
		}

		this._feeding = this.promiseToFeed(eventStream, lastSyncFetched);
		return this._feeding;
	}

	indexMore(): Promise<LastSync<ABI>> {
		if (this._feeding) {
			throw new Error(`feeding... cannot index until feeding is complete`);
		}

		if (this._indexingMore) {
			namedLogger.info(`still indexing...`);
			return this._indexingMore;
		}

		if (this._reseting) {
			namedLogger.info(`reseting...`);
			this._indexingMore = this._reseting.then(() => this.promiseToIndex());
		} else {
			this._indexingMore = this.promiseToIndex();
		}
		return this._indexingMore;
	}

	// ------------------------------------------------------------------------------------------------------------------
	// INTERNALS
	// ------------------------------------------------------------------------------------------------------------------

	protected async signal(state: LoadingState) {
		if (this.onLoad) {
			namedLogger.info(`onLoad ${state}...`);
			await this.onLoad(state, this.lastSync);
			namedLogger.info(`...onLoad ${state}`);
		}
	}

	protected async promiseToLoad(): Promise<LastSync<ABI>> {
		try {
			this.configHash = await hash(this.streamConfig);
			// TODO handle history (in reverse order)
			this.sourceHashes = [{startBlock: 0, hash: await hash(this.source)}];

			const chainId = await this.provider.request({method: 'eth_chainId'});
			if (parseInt(chainId.slice(2), 16).toString() !== this.source.chainId) {
				throw new Error(
					`Connected to a different chain (chainId : ${chainId}). Expected chainId === ${this.source.chainId}`
				);
			}

			let currentLastSync: LastSync<ABI> | undefined = undefined;
			await this.signal('Loading');
			const processorHash = this.processor.getVersionHash();
			const loaded = await this.processor.load(this.source);
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
					// this.processor.clear(); // TODO ?
				}
			}
			// if mismatch found, we get a fresh sync
			if (!currentLastSync) {
				currentLastSync = this.freshLastSync(processorHash);
				// but we might have some stream still valid here
				if (this.existingStream) {
					await this.signal('Fetching');
					// we start from scratch
					const existingStreamData = await this.existingStream.fetchFrom(
						this.source,
						getFromBlock(currentLastSync, this.finality) // this is 0 as we found a mistmatch, we need all logs
					);

					// we assume the stream is correct and start from the requested number
					if (existingStreamData) {
						const {eventStream: eventsFetched, lastSync: lastSyncFetched} = existingStreamData;
						if (this.indexerMatches(lastSyncFetched.lastToBlock, lastSyncFetched.context)) {
							// we update the processorHash in case it was changed
							currentLastSync.context.processor = processorHash;
							this.lastSync = currentLastSync;
							if (eventsFetched.length > 0) {
								await this.signal('Processing');
								await this.feed(eventsFetched, lastSyncFetched);
							}
						} else {
							this.lastSync = currentLastSync;
							await this.existingStream.clear(this.source);
						}
					} else {
						this.lastSync = currentLastSync;
						await this.existingStream.clear(this.source);
					}
				} else {
					this.lastSync = currentLastSync;
				}
			} else {
				if (this.existingStream) {
					// we still need to clear if it does not matches, as otherwise it will be written as if it contained all logs
					const existingStreamData = await this.existingStream.fetchFrom(
						this.source,
						getFromBlock(currentLastSync, this.finality) // this is 0 as we found a mistmatch, we need all logs
					);
					const {lastSync: lastSyncFetched} = existingStreamData;
					if (this.indexerMatches(lastSyncFetched.lastToBlock, lastSyncFetched.context)) {
						await this.existingStream.clear(this.source);
					}
				}
				this.lastSync = currentLastSync;
			}
			await this.signal('Done');
			return this.lastSync;
		} finally {
			this._loading = undefined;
		}
	}

	protected async promiseToFeed(newEvents: LogEvent<ABI>[], lastSyncFetched: LastSync<ABI>): Promise<LastSync<ABI>> {
		try {
			// assume lastSyncFetched is newer
			// TODO throw otherwise ?

			if (!this.lastSync) {
				this.lastSync = this.freshLastSync(this.processor.getVersionHash());
			}
			const {eventStream, newLastSync} = generateStreamToAppend(this.lastSync, newEvents, {
				newLatestBlock: lastSyncFetched.latestBlock,
				newLastToBlock: lastSyncFetched.lastToBlock,
				finality: this.finality,
			});

			const eventsInGroups = groupLogsPerBlock(eventStream);
			// TODO config batchSize
			const batchSize = 300;
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
					await this.signal('Processing'); // TODO call it "Feeding"
					currentLastSync.lastToBlock = list[list.length - 1].blockNumber;
					const outcome = await this.processor.process(list, currentLastSync);
					this.lastSync = currentLastSync;

					this.rejectIfAborted('_feeding');

					this._onStateUpdated(outcome);

					await wait(0.001);

					this.rejectIfAborted('_feeding');
				}
			}
			this.lastSync = newLastSync;

			return this.lastSync;
		} finally {
			this._feeding = undefined;
		}
	}
	protected async save(source: IndexingSource<ABI>, eventStream: LogEvent<ABI>[], lastSync: LastSync<ABI>) {
		if (!this._saving) {
			if (this.existingStream) {
				this._saving = this.promiseToSave(source, eventStream, lastSync);
				return this._saving;
			} else {
				return Promise.resolve();
			}
		}
		// we keep previous attempt
		// if fails we still fail though
		return this._saving.then(() => this.promiseToSave(source, eventStream, lastSync));
	}

	protected async promiseToSave(source: IndexingSource<ABI>, eventStream: LogEvent<ABI>[], lastSync: LastSync<ABI>) {
		this.appendedStreamNotYetSaved.push(...eventStream);
		try {
			await this.existingStream?.saveNewEvents(source, {
				eventStream: this.appendedStreamNotYetSaved,
				lastSync,
			});
			this.appendedStreamNotYetSaved.splice(0, this.appendedStreamNotYetSaved.length);
		} catch (e) {
			namedLogger.error(`could not save stream, ${e}`);
			// ignore error
		} finally {
			this._saving = undefined;
		}
	}

	protected async promiseToIndex(): Promise<LastSync<ABI>> {
		try {
			if (!this.lastSync) {
				namedLogger.info(`load lastSync...`);
				await this.load();
			}
			const previousLastSync = this.lastSync as LastSync<ABI>;
			const {lastSync: newLastSync, eventStream} = await this.fetchLogsFromProvider(previousLastSync);

			this.rejectIfAborted('_indexingMore');

			// ----------------------------------------------------------------------------------------
			// MAKE THE PROCESSOR PROCESS IT
			// ----------------------------------------------------------------------------------------
			const outcome = await this.processor.process(eventStream, newLastSync);

			this.rejectIfAborted('_indexingMore');

			// this does not throw, but we could be stuck here ?
			// TODO timeout ?
			await this.save(this.source, eventStream, newLastSync);

			this._onStateUpdated(outcome);

			this.lastSync = newLastSync;
			return this.lastSync;
			// ----------------------------------------------------------------------------------------
		} finally {
			this._indexingMore = undefined;
		}
	}

	async fetchLogsFromProvider<ABI extends Abi>(
		lastSync: LastSync<ABI>
	): Promise<{lastSync: LastSync<ABI>; eventStream: LogEvent<ABI>[]}> {
		const lastUnconfirmedBlocks = lastSync.unconfirmedBlocks;

		// ----------------------------------------------------------------------------------------
		// COMPUTE fromBlock
		// ----------------------------------------------------------------------------------------
		let fromBlock = this.defaultFromBlock;
		if (lastUnconfirmedBlocks.length > 0) {
			// this is wrong, we need to take fromBlock from lastSync (+ finality or use fromBlock)
			fromBlock = lastUnconfirmedBlocks[0].number;
		} else {
			// same this is wrong, there could be reorg missed and event to add
			// fromBlock / lastSync need to be used and of course depending on lastSync.latestBlock to check finality of that last request
			if (lastSync.lastToBlock !== 0) {
				fromBlock = lastSync.lastToBlock + 1;
			}
		}
		// ----------------------------------------------------------------------------------------

		// ----------------------------------------------------------------------------------------
		// FETCH LOGS
		// ----------------------------------------------------------------------------------------
		const latestBlock = await getBlockNumber(this.provider);

		this.rejectIfAborted('_indexingMore');

		let toBlock = latestBlock;

		if (fromBlock > toBlock) {
			namedLogger.info(`no new block`);
			return {lastSync, eventStream: []};
		}

		const {events: eventsFetched, toBlockUsed: newToBlock} = await this.logEventFetcher.getLogEvents({
			fromBlock,
			toBlock: toBlock,
		});
		toBlock = newToBlock;

		this.rejectIfAborted('_indexingMore');

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

			if (this.alwaysFetchTransactions) {
				if (lastTransactionHash !== event.transactionHash) {
					fetchTransaction = true;
				}
			}

			if (this.alwaysFetchTimestamps) {
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
			const blocks = await this.getBlocks(blockHashes);

			this.rejectIfAborted('_indexingMore');

			namedLogger.info(`...got  ${blocks.length} blocks back`);

			for (let i = 0; i < blockHashes.length; i++) {
				blockTimestamps[blockHashes[i]] = blocks[i].timestamp;
			}
			anyFetch = true;
		}

		if (transactionHashes.length > 0) {
			namedLogger.info(`fetching a batch of ${transactionHashes.length} transactions...`);
			const transactionReceipts = await this.getTransactions(transactionHashes);

			this.rejectIfAborted('_indexingMore');

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
		const {eventStream, newLastSync} = generateStreamToAppend(lastSync, eventsFetched, {
			newLatestBlock: latestBlock,
			newLastToBlock: toBlock,
			finality: this.finality,
		});
		// ----------------------------------------------------------------------------------------

		return {lastSync: newLastSync, eventStream};
	}

	protected async getBlocks(blockHashes: string[]): Promise<{timestamp: number}[]> {
		if (this.providerSupportsETHBatch) {
			return getBlockDataFromMultipleHashes(this.provider, blockHashes);
		} else {
			const result = [];
			for (const blockHash of blockHashes) {
				namedLogger.info(`getting block ${blockHash}...`);
				const actualBlock = await getBlockData(this.provider, blockHash as EIP1193DATA);
				this.rejectIfAborted('_indexingMore');
				result.push(actualBlock);
			}
			return result;
		}
	}

	protected async getTransactions(transactionHashes: string[]): Promise<LogTransactionData[]> {
		if (this.providerSupportsETHBatch) {
			return getTransactionDataFromMultipleHashes(this.provider, transactionHashes);
		} else {
			const result = [];
			for (const transactionHash of transactionHashes) {
				namedLogger.info(`getting block ${transactionHash}...`);
				const tx = await getTransactionData(this.provider, transactionHash as EIP1193DATA);
				this.rejectIfAborted('_indexingMore');
				result.push(tx);
			}
			return result;
		}
	}

	protected indexerMatches(lastToBlock: number, context: ContextIdentifier): boolean {
		if (!this.sourceHashes || !this.configHash) {
			throw new Error(`no sourceHashes or configHash computed, please load first`);
		}
		if (context.config !== this.configHash) {
			return false;
		}

		for (let i = 0; i < this.sourceHashes.length; i++) {
			const indexerSourceItem = this.sourceHashes[i];
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

	protected freshLastSync(processorHash: string): LastSync<ABI> {
		if (!this.sourceHashes || !this.configHash) {
			throw new Error(`no sourceHashes or configHash computed, please load first`);
		}
		return {
			context: {source: this.sourceHashes, config: this.configHash, processor: processorHash},
			lastToBlock: 0,
			latestBlock: 0,
			unconfirmedBlocks: [],
		};
	}

	protected _onStateUpdated(outcome: ProcessResultType) {
		if (this.onStateUpdated) {
			try {
				this.onStateUpdated(outcome);
			} catch (err) {}
		}
	}

	protected rejectIfAborted(...fields: string[]) {
		for (const field of fields) {
			if ((this as any)[field]) {
				return; //one of them is on, we do not throw
			}
		}
		throw new Error(`Aborted: ${fields.join(',')}`);
	}
}
