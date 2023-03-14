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
	ExistingStreamFecther,
	StreamSaver,
	IndexerConfig,
	LastSync,
	AllContractData,
} from './types';
import {LogEvent, LogEventFetcher, ParsedLogsPromise, ParsedLogsResult} from './decoding/LogEventFetcher';
import type {Abi} from 'abitype';

const namedLogger = logs('ethereum-indexer');

export type LoadingState = 'Loading' | 'Fetching' | 'Processing' | 'Done';

export class EthereumIndexer<ABI extends Abi, ProcessResultType = void> {
	// ------------------------------------------------------------------------------------------------------------------
	// PUBLIC VARIABLES
	// ------------------------------------------------------------------------------------------------------------------

	public readonly defaultFromBlock: number;
	public onLoad: ((state: LoadingState) => Promise<void>) | undefined;
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
	protected fetchExistingStream: ExistingStreamFecther<ABI> | undefined;
	protected saveAppendedStream: StreamSaver<ABI> | undefined;
	protected appendedStreamNotYetSaved: EventWithId<ABI>[] = [];
	protected _reseting: Promise<void> | undefined;
	protected _loading: Promise<LastSync<ABI>> | undefined;
	protected _indexingMore: Promise<LastSync<ABI>> | undefined;
	protected _feeding: Promise<LastSync<ABI>> | undefined;
	protected _saving: Promise<void> | undefined;
	protected _savingProcessor: Promise<void> | undefined;
	protected _logEventPromise: ParsedLogsPromise<ABI>;

	// ------------------------------------------------------------------------------------------------------------------
	// CONSTRUCTOR
	// ------------------------------------------------------------------------------------------------------------------

	constructor(
		protected provider: EIP1193ProviderWithoutEvents,
		protected processor: EventProcessor<ABI, ProcessResultType>,
		protected source: IndexingSource<ABI>,
		config: IndexerConfig<ABI> = {}
	) {
		this.finality = config.finality || 12;
		this.logEventFetcher = new LogEventFetcher(provider, source.contracts, config, config?.parseConfig);
		this.alwaysFetchTimestamps = config.alwaysFetchTimestamps ? true : false;
		this.alwaysFetchTransactions = config.alwaysFetchTransactions ? true : false;
		this.fetchExistingStream = config.keepStream?.fetcher;
		this.saveAppendedStream = config.keepStream?.saver;

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
			this.lastSync = {
				lastToBlock: 0,
				latestBlock: 0,
				nextStreamID: 1,
				unconfirmedBlocks: [],
			};
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
			await this.onLoad(state);
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

			let lastSync = this.lastSync;
			if (!lastSync) {
				await this.signal('Loading');
				const {lastSync: loadedLastSync, state} = await this.processor.load(this.source);
				lastSync = loadedLastSync;
				this._onStateUpdated(state);
			}

			if (this.fetchExistingStream) {
				await this.signal('Fetching');
				const existingStreamData = await this.fetchExistingStream(this.source, lastSync.nextStreamID);

				if (existingStreamData) {
					const {eventStream, lastSync: lastSyncFetched} = existingStreamData;

					const eventStreamToFeed = eventStream.filter(
						(event) =>
							event.streamID >= lastSync.nextStreamID &&
							event.blockNumber < Math.max(0, lastSyncFetched.latestBlock - this.finality)
					);

					namedLogger.info(`${eventStreamToFeed.length} events loaded, feeding...`);
					if (eventStreamToFeed.length > 0) {
						await this.signal('Processing');
						// TODO in batch ?
						lastSync = await this.feed(eventStreamToFeed, lastSyncFetched);
					}
					namedLogger.info(`${eventStreamToFeed.length} events feeded`);
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
		lastSyncFetched?: LastSync<ABI>
	): Promise<LastSync<ABI>> {
		try {
			// this create an infinite loop as load call promise
			// TODO if we need to call promise first, we could add an option to load (and load will not use that option)
			// if (!this.lastSync) {
			// 	namedLogger.info(`load lastSync...`);
			// 	await this.load();
			// }
			const lastSync: LastSync<ABI> = this.lastSync || {
				lastToBlock: 0,
				latestBlock: 0,
				nextStreamID: 1,
				unconfirmedBlocks: [],
			};

			const firstEvent = eventStream[0];
			const lastEvent = eventStream[eventStream.length - 1];

			let newLastSync = lastSyncFetched;

			if (!newLastSync) {
				const latestBlock = await getBlockNumber(this.provider);

				if (!this._feeding) {
					namedLogger.info(`not feeding anymore...`);
					throw new Error('aborted');
				}

				if (latestBlock - lastEvent.blockNumber < this.finality) {
					throw new Error('do not accept unconfirmed blocks');
				}
				newLastSync = {
					latestBlock: latestBlock,
					lastToBlock: lastEvent.blockNumber,
					unconfirmedBlocks: [],
					nextStreamID: lastEvent.streamID + 1,
				};
			}
			if (firstEvent.streamID === lastSync.nextStreamID) {
				const outcome = await this.processor.process(eventStream, newLastSync);
				if (!this._feeding) {
					namedLogger.info(`not feeding anymore...`);
					throw new Error('aborted');
				}
				this.lastSync = newLastSync;
				this._onStateUpdated(outcome);
			} else {
				throw new Error(`invalid nextStreamID, ${firstEvent.streamID} === ${lastSync.nextStreamID}`);
			}
			return this.lastSync;
		} finally {
			this._feeding = undefined;
		}
	}

	protected async save(source: IndexingSource<ABI>, eventStream: EventWithId<ABI>[], lastSync: LastSync<ABI>) {
		if (!this._saving) {
			if (this.saveAppendedStream) {
				this._saving = this.promiseToSave(source, eventStream, lastSync);
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
			await this.saveAppendedStream(source, {
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

					if (
						this.alwaysFetchTransactions ||
						(this.processor.shouldFetchTransaction && this.processor.shouldFetchTransaction(event))
					) {
						if (lastTransactionHash !== event.transactionHash) {
							fetchTransaction = true;
						}
					}

					if (
						this.alwaysFetchTimestamps ||
						(this.processor.shouldFetchTimestamp && this.processor.shouldFetchTimestamp(event))
					) {
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

				let newEvents = eventsFetched;
				if (this.processor.filter) {
					namedLogger.info(`filtering...`);
					newEvents = await this.processor.filter(eventsFetched);
				}

				if (!this._indexingMore) {
					namedLogger.info(`not indexing anymore...`);
					reject('aborted');
					return;
				}

				const {eventStream, newLastSync} = this._generateStreamToAppend(newEvents, {
					latestBlock,
					lastToBlock: toBlock,
					nextStreamID: streamID,
					unconfirmedBlocks,
				});
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
		{latestBlock, lastToBlock, unconfirmedBlocks, nextStreamID}: LastSync<ABI>
	): {eventStream: EventWithId<ABI>[]; newLastSync: LastSync<ABI>} {
		// grouping per block...
		const groups: {[hash: string]: BlockEvents<ABI>} = {};
		const eventsGroupedPerBlock: BlockEvents<ABI>[] = [];
		for (const event of newEvents) {
			let group = groups[event.blockHash];
			if (!group) {
				group = groups[event.blockHash] = {
					hash: event.blockHash,
					number: event.blockNumber,
					events: [],
				};
				eventsGroupedPerBlock.push(group);
			}
			group.events.push(event);
		}

		// set up the new entries to be added to the stream
		// const newEventEntries: DurableObjectEntries<LogEvent> = {};
		const eventStream: EventWithId<ABI>[] = [];

		// find reorgs
		let reorgBlock: EventBlock<ABI> | undefined;
		let reorgedBlockIndex = 0;
		for (const block of eventsGroupedPerBlock) {
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
						...event,
						streamID: nextStreamID++,
						removed: true,
					});
				}
			}
		}

		const startingBlockForNewEvent = reorgBlock
			? reorgBlock.number
			: unconfirmedBlocks.length > 0
			? unconfirmedBlocks[unconfirmedBlocks.length - 1].number + 1
			: eventsGroupedPerBlock.length > 0
			? eventsGroupedPerBlock[0].number
			: 0;
		// the case for 0 is a void case as none of the loop below will be triggered

		// new events and new unconfirmed blocks
		const newUnconfirmedBlocks: EventBlock<ABI>[] = [];
		const newUnconfirmedStream: LogEvent<ABI>[] = [];

		// re-add unconfirmed blocks that might get reorg later still
		for (const unconfirmedBlock of unconfirmedBlocks) {
			if (unconfirmedBlock.number < startingBlockForNewEvent) {
				if (latestBlock - unconfirmedBlock.number <= this.finality) {
					newUnconfirmedBlocks.push(unconfirmedBlock);
				}
			}
		}

		for (const block of eventsGroupedPerBlock) {
			if (block.events.length > 0 && block.number >= startingBlockForNewEvent) {
				for (const event of block.events) {
					eventStream.push({streamID: nextStreamID++, ...event});
				}
				if (latestBlock - block.number <= this.finality) {
					newUnconfirmedBlocks.push({
						hash: block.hash,
						number: block.number,
						events: block.events,
					});

					for (const event of block.events) {
						// TODO slim the event down ?
						//  remove:
						//  - topics
						//  - data // assuming the event has been parsed succesfully
						//  - args named // indexed based is more universal but named one are easier, choose
						//  - signature
						//  - topic
						newUnconfirmedStream.push({...event});
					}
				}
			}
		}

		return {
			eventStream,
			newLastSync: {
				latestBlock,
				lastToBlock,
				unconfirmedBlocks: newUnconfirmedBlocks,
				nextStreamID,
			},
		};
	}
}
