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
	BlockEvents,
	IndexingSource,
	EventBlock,
	EventProcessor,
	EventWithId,
	IndexerConfig,
	LastSync,
	AllContractData,
	ContextIdentifier,
	ExistingStream,
} from './types';
import {LogEvent, LogEventFetcher, ParsedLogsPromise, ParsedLogsResult} from './decoding/LogEventFetcher';
import type {Abi} from 'abitype';
import {wait} from './engine/utils';

const namedLogger = logs('ethereum-indexer');

export type LoadingState = 'Loading' | 'Fetching' | 'Processing' | 'Done';

// PROPOSAL FOR STATE ANCHORS
// we can have state anchor that get provided by the processor
// these set the minimum block to start fetching from

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
	protected existingStream: ExistingStream<ABI>;
	protected appendedStreamNotYetSaved: EventWithId<ABI>[] = [];
	protected _reseting: Promise<void> | undefined;
	protected _loading: Promise<LastSync<ABI>> | undefined;
	protected _indexingMore: Promise<LastSync<ABI>> | undefined;
	protected _feeding: Promise<LastSync<ABI>> | undefined;
	protected _saving: Promise<void> | undefined;
	protected _savingProcessor: Promise<void> | undefined;
	protected _logEventPromise: ParsedLogsPromise<ABI>;

	protected sourceHashes: {startBlock: number; hash: string}[];
	protected configHash: string;
	// ------------------------------------------------------------------------------------------------------------------
	// CONSTRUCTOR
	// ------------------------------------------------------------------------------------------------------------------

	constructor(
		protected provider: EIP1193ProviderWithoutEvents,
		protected processor: EventProcessor<ABI, ProcessResultType>,
		protected source: IndexingSource<ABI>,
		config: IndexerConfig<ABI> = {}
	) {
		this.finality = config.stream.finality || 12;
		this.logEventFetcher = new LogEventFetcher(provider, source.contracts, config?.fetch, config?.stream.parse);
		this.alwaysFetchTimestamps = config.stream.alwaysFetchTimestamps ? true : false;
		this.alwaysFetchTransactions = config.stream.alwaysFetchTransactions ? true : false;
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

		this.sourceHashes = [{startBlock: 0, hash: 'TODO'}];
		this.configHash = 'TODO';
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
			this._logEventPromise.stopRetrying();
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

	async feed(eventStream: EventWithId<ABI>[], lastSyncFetched?: LastSync<ABI>): Promise<LastSync<ABI>> {
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
			const chainId = await this.provider.request({method: 'eth_chainId'});
			if (parseInt(chainId.slice(2), 16).toString() !== this.source.chainId) {
				throw new Error(
					`Connected to a different chain (chainId : ${chainId}). Expected chainId === ${this.source.chainId}`
				);
			}

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

			let lastSync: LastSync<ABI> | undefined = undefined;
			await this.signal('Loading');
			const processorHash = this.processor.getVersionHash();
			const loaded = await this.processor.load(this.source);
			if (loaded) {
				const {lastSync: loadedLastSync, state} = loaded;
				if (
					processorHash === loadedLastSync.context.processor &&
					this.indexerMatches(loadedLastSync.lastToBlock, loadedLastSync.context)
				) {
					lastSync = loadedLastSync;
					this._onStateUpdated(state);
				} else {
					namedLogger.log(`STATE DISCARDED AS PROCESSOR CHANGED`);
					// this.processor.clear(); // TODO ?
				}
			}
			// if mismatch found, we get a fresh sync
			if (!lastSync) {
				lastSync = this.freshLastSync(processorHash);
				// but we might have some stream still valid here
				if (this.existingStream) {
					await this.signal('Fetching');
					// we start from scratch
					const existingStreamData = await this.existingStream.fetchFrom(this.source, lastSync.nextStreamID);

					if (existingStreamData) {
						const {eventStream, lastSync: lastSyncFetched} = existingStreamData;
						if (this.indexerMatches(lastSyncFetched.lastToBlock, lastSyncFetched.context)) {
							// we update the processorHash in case it was changed
							lastSyncFetched.context.processor = processorHash;

							const eventStreamToFeed = eventStream.filter(
								(event) => event.blockNumber < Math.max(0, lastSyncFetched.latestBlock - this.finality)
							);

							// removeRemovedEventFromStream(eventStreamToFeed);
							const evenStreamNormalized: EventWithId<ABI>[] = [];
							const eventMap: {[streamID: string]: number} = {};
							for (let i = 0; i < eventStreamToFeed.length; i++) {
								const event = eventStreamToFeed[i];

								if ('removedStreamID' in event && event.removedStreamID) {
									const eventIndexFromMap = eventMap[event.removedStreamID];
									// evenStreamNormalized[eventIndexFromMap] = {
									// 	...evenStreamNormalized[eventIndexFromMap],
									// 	cancelled: true,
									// };
									evenStreamNormalized.splice(eventIndexFromMap, 1);
									// we leave gap in the streamID
								} else {
									eventMap[event.streamID] = evenStreamNormalized.length;
									evenStreamNormalized.push(event);
								}
							}

							if (evenStreamNormalized.length > 0) {
								await this.signal('Processing');
								// TODO config for batchsize?
								const batchSize = 300;
								lastSync = lastSyncFetched;

								for (let i = 0; i < evenStreamNormalized.length; i += batchSize) {
									const slice = eventStreamToFeed.slice(i, Math.min(i + batchSize, evenStreamNormalized.length));
									if (slice.length > 0) {
										lastSync.nextStreamID = slice[slice.length - 1].streamID + 1;
										await this.feed(slice, lastSync);
										await this.signal('Processing');
										await wait(0.001);
									}
								}
							}
						} else {
							await this.existingStream.clear(this.source);
						}
					} else {
						await this.existingStream.clear(this.source);
					}
				}
			}

			await this.signal('Done');

			this.lastSync = lastSync;
			return this.lastSync;
		} finally {
			this._loading = undefined;
		}
	}

	_onStateUpdated(outcome: ProcessResultType) {
		if (this.onStateUpdated) {
			try {
				this.onStateUpdated(outcome);
			} catch (err) {}
		}
	}

	protected async promiseToFeed(
		eventStream: EventWithId<ABI>[],
		lastSyncFetched: LastSync<ABI>
	): Promise<LastSync<ABI>> {
		try {
			const lastSync: LastSync<ABI> = this.lastSync || this.freshLastSync(this.processor.getVersionHash());
			const firstEvent = eventStream[0];
			if (firstEvent.streamID === lastSync.nextStreamID) {
				namedLogger.time('processor.process');
				// TODO if clean feed (no removed event) then we can mentioned that to the processor
				// this would allow the processor to not need to keep previous state for reorg
				// this can significantly speed up a browser based indexer
				const outcome = await this.processor.process(eventStream, lastSyncFetched);
				namedLogger.timeEnd('processor.process');
				if (!this._feeding) {
					namedLogger.info(`not feeding anymore...`);
					throw new Error('aborted');
				}
				this.lastSync = lastSyncFetched;

				namedLogger.time('_onStateUpdated');
				this._onStateUpdated(outcome);
				namedLogger.timeEnd('_onStateUpdated');

				return this.lastSync;
			} else {
				throw new Error(`invalid nextStreamID, ${firstEvent.streamID} === ${lastSync.nextStreamID}`);
			}
		} finally {
			this._feeding = undefined;
		}
	}

	protected indexerMatches(lastToBlock: number, context: ContextIdentifier): boolean {
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
		return {
			context: {source: this.sourceHashes, config: this.configHash, processor: processorHash},
			lastToBlock: 0,
			latestBlock: 0,
			nextStreamID: 1,
			unconfirmedBlocks: [],
		};
	}

	protected async save(source: IndexingSource<ABI>, eventStream: EventWithId<ABI>[], lastSync: LastSync<ABI>) {
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

	protected async promiseToSave(source: IndexingSource<ABI>, eventStream: EventWithId<ABI>[], lastSync: LastSync<ABI>) {
		this.appendedStreamNotYetSaved.push(...eventStream);
		try {
			await this.existingStream.saveNewEvents(source, {
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

	protected async getBlocks(blockHashes: string[]): Promise<{timestamp: number}[]> {
		if (this.providerSupportsETHBatch) {
			return getBlockDataFromMultipleHashes(this.provider, blockHashes);
		} else {
			const result = [];
			for (const blockHash of blockHashes) {
				namedLogger.info(`getting block ${blockHash}...`);
				const actualBlock = await getBlockData(this.provider, blockHash as EIP1193DATA);
				if (!this._indexingMore) {
					return;
				}
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
				if (!this._indexingMore) {
					return;
				}
				result.push(tx);
			}
			return result;
		}
	}

	protected promiseToIndex(): Promise<LastSync<ABI>> {
		return new Promise(async (resolve, reject) => {
			try {
				if (!this.lastSync) {
					namedLogger.info(`load lastSync...`);
					await this.load();
				}
				const lastSync = this.lastSync as LastSync<ABI>;

				const unconfirmedBlocks = lastSync.unconfirmedBlocks;
				let streamID = lastSync.nextStreamID;

				let fromBlock = this.defaultFromBlock;
				if (unconfirmedBlocks.length > 0) {
					fromBlock = lastSync.unconfirmedBlocks[0].number;
				} else {
					if (lastSync.lastToBlock !== 0) {
						fromBlock = lastSync.lastToBlock + 1;
					}
				}

				const latestBlock = await getBlockNumber(this.provider);

				if (!this._indexingMore) {
					namedLogger.info(`not indexing anymore...`);
					reject('aborted');
					return;
				}

				let toBlock = latestBlock;

				if (fromBlock > toBlock) {
					namedLogger.info(`no new block`);
					this._indexingMore = undefined;
					return resolve(lastSync);
				}

				if (this._logEventPromise) {
					throw new Error(`duplicate _logEventPromise`);
				}
				this._logEventPromise = this.logEventFetcher.getLogEvents({
					fromBlock,
					toBlock: toBlock,
				});

				let logResult: ParsedLogsResult<ABI>;
				try {
					logResult = await this._logEventPromise;
				} finally {
					this._logEventPromise = undefined;
				}

				const {events: eventsFetched, toBlockUsed: newToBlock} = logResult;
				toBlock = newToBlock;

				if (!this._indexingMore) {
					namedLogger.info(`not indexing anymore...`);
					reject('aborted');
					return;
				}

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
					namedLogger.info(`...got  ${blocks.length} blocks back`);
					if (!this._indexingMore) {
						namedLogger.info(`not indexing anymore...`);
						reject('aborted');
						return;
					}

					for (let i = 0; i < blockHashes.length; i++) {
						blockTimestamps[blockHashes[i]] = blocks[i].timestamp;
					}
					anyFetch = true;
				}

				if (transactionHashes.length > 0) {
					namedLogger.info(`fetching a batch of ${transactionHashes.length} transactions...`);
					const transactionReceipts = await this.getTransactions(transactionHashes);
					namedLogger.info(`...got ${transactionReceipts.length} transactions back`);
					if (!this._indexingMore) {
						namedLogger.info(`not indexing anymore...`);
						reject('aborted');
						return;
					}

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

				if (!this._indexingMore) {
					namedLogger.info(`not indexing anymore...`);
					reject('aborted');
					return;
				}

				const {eventStream, newLastSync} = this._generateStreamToAppend(eventsFetched, {
					context: lastSync.context,
					latestBlock,
					lastToBlock: toBlock,
					nextStreamID: streamID,
					unconfirmedBlocks,
				});

				if (newLastSync.nextStreamID > 1) {
					namedLogger.log(`nextStreamID ${newLastSync.nextStreamID}`);
				}
				// TODO const chainId = await getChainId(this.provider);

				// Note: we do not skip if  (eventStream.length > 0)
				//  Because the process might want to use that info to keep track of the syncinf status

				const outcome = await this.processor.process(eventStream, newLastSync);

				if (this._reseting && !this._indexingMore) {
					// we only skip here if reseting has been started
					// if the indexing was aborted because of a call to stopProcessing, then we should proceed to finish it
					namedLogger.info(`reseting has started, not indexing anymore...`);
					reject('aborted');
					return;
				}

				this.lastSync = newLastSync;

				// this does not throw, but we could be stuck here ?
				// TODO timeout ?
				await this.save(this.source, eventStream, this.lastSync);

				this._onStateUpdated(outcome);

				this._indexingMore = undefined;
				return resolve(newLastSync);
			} catch (e: any) {
				globalThis.console.error(`error`, e);
				this._indexingMore = undefined;
				return reject(e);
			}
		});
	}

	protected _generateStreamToAppend(
		newEvents: LogEvent<ABI>[],
		{context, latestBlock, lastToBlock, unconfirmedBlocks, nextStreamID}: LastSync<ABI>
	): {eventStream: EventWithId<ABI>[]; newLastSync: LastSync<ABI>} {
		// grouping per block...
		const groups: {[hash: string]: BlockEvents<ABI>} = {};
		const logEventsGroupedPerBlock: BlockEvents<ABI>[] = [];
		for (const event of newEvents) {
			if (event.removed) {
				// we skip event removed as we deal with them manually
				continue;
			}
			let group = groups[event.blockHash];
			if (!group) {
				group = groups[event.blockHash] = {
					hash: event.blockHash,
					number: event.blockNumber,
					events: [],
				};
				logEventsGroupedPerBlock.push(group);
			}
			group.events.push(event);
		}

		const eventStream: EventWithId<ABI>[] = [];

		// find reorgs
		let reorgBlock: EventBlock<ABI> | undefined;
		let reorgedBlockIndex = 0;
		for (const block of logEventsGroupedPerBlock) {
			if (reorgedBlockIndex < unconfirmedBlocks.length) {
				const unconfirmedBlockAtIndex = unconfirmedBlocks[reorgedBlockIndex];
				if (unconfirmedBlockAtIndex.hash !== block.hash) {
					reorgBlock = unconfirmedBlockAtIndex;
					break;
				}
				reorgedBlockIndex++;
			}
		}

		if (reorgBlock) {
			// re-add event to the stream but flag them as removed
			for (let i = reorgedBlockIndex; i < unconfirmedBlocks.length; i++) {
				for (const event of unconfirmedBlocks[i].events) {
					eventStream.push({
						...event, // TODO delete that ?
						streamID: nextStreamID++,
						removed: true, // delete that ?
						removedStreamID: event.streamID,
					});
				}
			}
		}

		const startingBlockForNewEvent = reorgBlock
			? reorgBlock.number
			: unconfirmedBlocks.length > 0
			? unconfirmedBlocks[unconfirmedBlocks.length - 1].number + 1
			: logEventsGroupedPerBlock.length > 0
			? logEventsGroupedPerBlock[0].number
			: 0;
		// the case for 0 is a void case as none of the loop below will be triggered

		// new events and new unconfirmed blocks
		const newUnconfirmedBlocks: EventBlock<ABI>[] = [];

		// re-add unconfirmed blocks that might get reorg later still
		for (const unconfirmedBlock of unconfirmedBlocks) {
			if (unconfirmedBlock.number < startingBlockForNewEvent) {
				if (latestBlock - unconfirmedBlock.number <= this.finality) {
					newUnconfirmedBlocks.push(unconfirmedBlock);
				}
			}
		}

		for (const block of logEventsGroupedPerBlock) {
			if (block.events.length > 0 && block.number >= startingBlockForNewEvent) {
				const newEventsPerBlock: EventWithId<ABI>[] = [];
				for (const event of block.events) {
					const newEvent: EventWithId<ABI> = {streamID: nextStreamID++, ...event};
					eventStream.push(newEvent);
					newEventsPerBlock.push(newEvent);
				}
				if (latestBlock - block.number <= this.finality) {
					newUnconfirmedBlocks.push({
						hash: block.hash,
						number: block.number,
						events: newEventsPerBlock,
					});
				}
			}
		}

		return {
			eventStream,
			newLastSync: {
				context,
				latestBlock,
				lastToBlock,
				unconfirmedBlocks: newUnconfirmedBlocks,
				nextStreamID,
			},
		};
	}
}
