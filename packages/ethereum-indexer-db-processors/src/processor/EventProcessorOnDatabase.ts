import {IndexingSource, EventWithId, LastSync, LogEvent, Abi, UnparsedEventWithId} from 'ethereum-indexer';
import {logs} from 'named-logs';
import {QueriableEventProcessor} from './QueriableEventProcessor';
import {Database, FromDB, JSONObject, PutAndGetDatabase, Query, Result} from './Database';
import {RevertableDatabase} from './RevertableDatabase';

const console = logs('EventProcessorOnDatabase');

export interface SingleEventProcessor<ABI extends Abi> {
	processEvent(db: PutAndGetDatabase, event: EventWithId<ABI>): Promise<void>;
	setup?(db: Database): Promise<void>;
	shouldFetchTimestamp?(event: LogEvent<ABI>): boolean;
	shouldFetchTransaction?(event: LogEvent<ABI>): boolean;
	filter?: (eventsFetched: LogEvent<ABI>[]) => Promise<LogEvent<ABI>[]>;
	handleUnparsedEvent?(event: UnparsedEventWithId);
}

export class EventProcessorOnDatabase<ABI extends Abi> implements QueriableEventProcessor<ABI> {
	private initialization: Promise<void> | undefined;
	private revertableDatabase: RevertableDatabase<ABI>;
	constructor(private singleEventProcessor: SingleEventProcessor<ABI>, protected db: Database) {
		this.initialization = this.init();
		// this.revertableDatabase = new RevertableDatabase(db, true); // this allow time-travel queries but requires processing and will not scale
		this.revertableDatabase = new RevertableDatabase(db);
	}

	private init(): Promise<void> {
		if (this.singleEventProcessor.setup) {
			this.initialization = this.singleEventProcessor.setup(this.db);
			return this.initialization;
		} else {
			return Promise.resolve();
		}
	}

	async reset() {
		console.info('EventProcessorOnDatabase reseting...');
		this.db = await this.db.reset();
		this.initialization = undefined;
		await this.init();
	}

	async load(source: IndexingSource<ABI>): Promise<LastSync<ABI>> {
		// TODO check if source matches old sync
		const lastSync = await this.db.get('lastSync');
		if (lastSync) {
			return lastSync as unknown as LastSync<ABI>;
		} else {
			return {
				lastToBlock: 0,
				latestBlock: 0,
				nextStreamID: 1,
				unconfirmedBlocks: [],
			};
		}
	}

	private lastEventID: number;
	private processing: boolean;
	async process(eventStream: EventWithId<ABI>[], lastSync: LastSync<ABI>): Promise<void> {
		if (this.processing) {
			throw new Error(`processing...`);
		}
		this.processing = true;
		// console.log(`processing stream (nextStreamID: ${lastSync.nextStreamID})`)

		try {
			let lastBlock: number | undefined;
			let lastBlockDeleted: string | undefined;
			for (const event of eventStream) {
				if (this.lastEventID && event.streamID <= this.lastEventID) {
					continue;
				}
				if (event.removed) {
					console.info(`EventProcessorOnDatabase event removed....`);

					if (!lastBlockDeleted || event.blockHash != lastBlockDeleted) {
						console.info(`EventProcessorOnDatabase preparing block...`);
						await this.revertableDatabase.deleteBlock({hash: event.blockHash, number: event.blockNumber});
						lastBlockDeleted = event.blockHash;
					}

					await this.revertableDatabase.remove(event);
				} else {
					if (!lastBlock || event.blockNumber > lastBlock) {
						if (lastBlock) {
							await this.revertableDatabase.postBlock(lastBlock);
						}

						// TODO only update if not already up to date, TODO Database api for this
						await this.db.put({_id: `block`, number: event.blockNumber, hash: event.blockHash});

						console.info(`EventProcessorOnDatabase preparing block...`);
						await this.revertableDatabase.prepareBlock({hash: event.blockHash, number: event.blockNumber});
						lastBlock = event.blockNumber;
					}

					console.info(`EventProcessorOnDatabase preparing event...`);
					await this.revertableDatabase.prepareEvent(event);
					console.info(`EventProcessorOnDatabase processing event...`);
					await this.singleEventProcessor.processEvent(this.revertableDatabase, event);
					console.info(`EventProcessorOnDatabase DONE`);
				}

				if (lastBlock) {
					await this.revertableDatabase.postBlock(lastBlock);
				}

				this.lastEventID = event.streamID;
				if (!this.initialization) {
					break; // stop
				}
			}
			let lastLastSync;
			try {
				lastLastSync = await this.db.get('lastSync');
			} catch (err) {}
			const lastSyncDoc = {
				_id: 'lastSync',
				_rev: lastLastSync?._rev,
				...lastSync,
			};
			await this.db.put(lastSyncDoc);
		} finally {
			this.processing = false;
			console.info(`EventProcessorOnDatabase streamID: ${lastSync.nextStreamID}`);
		}
	}

	shouldFetchTimestamp(event: LogEvent<ABI>): boolean {
		return this.singleEventProcessor.shouldFetchTimestamp && this.singleEventProcessor.shouldFetchTimestamp(event);
	}

	shouldFetchTransaction(event: LogEvent<ABI>): boolean {
		return this.singleEventProcessor.shouldFetchTransaction && this.singleEventProcessor.shouldFetchTransaction(event);
	}

	query<T>(request: Query | (Query & ({blockHash: string} | {blockNumber: number}))): Promise<Result> {
		if ('blockHash' in request || 'blockNumber' in request) {
			return this.revertableDatabase.queryAtBlock(request);
		}
		return this.db.query({
			...request,
			selector: {...request.selector, endBlock: Number.MAX_SAFE_INTEGER},
		});
	}

	get<T extends JSONObject>(id: string): Promise<FromDB<T> | null> {
		return this.db.get(id);
	}
}
