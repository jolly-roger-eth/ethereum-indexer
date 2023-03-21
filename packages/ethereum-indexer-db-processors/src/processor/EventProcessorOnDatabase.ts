import {IndexingSource, LastSync, LogEvent, Abi, LogEventWithParsingFailure, UsedStreamConfig} from 'ethereum-indexer';
import {
	QueriableEventProcessor,
	Database,
	FromDB,
	JSONObject,
	PutAndGetDatabase,
	Query,
	Result,
} from 'ethereum-indexer-db-utils';
import {logs} from 'named-logs';
import {RevertableDatabase} from './RevertableDatabase';

const console = logs('EventProcessorOnDatabase');

export interface SingleEventProcessor<ABI extends Abi> {
	getVersionHash(): string;
	processEvent(db: PutAndGetDatabase, event: LogEvent<ABI>): Promise<void>;
	setup?(db: Database): Promise<void>;
	handleUnparsedEvent?(event: LogEventWithParsingFailure): void;
}

export class EventProcessorOnDatabase<ABI extends Abi> implements QueriableEventProcessor<ABI, void> {
	private initialization: Promise<void> | undefined;
	private revertableDatabase: RevertableDatabase<ABI>;
	constructor(private singleEventProcessor: SingleEventProcessor<ABI>, protected db: Database) {
		this.initialization = this.init();
		// this.revertableDatabase = new RevertableDatabase(db, true); // this allow time-travel queries but requires processing and will not scale
		this.revertableDatabase = new RevertableDatabase(db);
	}

	getVersionHash(): string {
		return this.singleEventProcessor.getVersionHash();
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
		this.initialization = undefined;
		await this.init();
	}

	async clear() {
		this.db = await this.db.reset();
		return this.reset();
	}

	async load(
		source: IndexingSource<ABI>,
		streamConfig: UsedStreamConfig
	): Promise<{lastSync: LastSync<ABI>; state: void} | undefined> {
		this.revertableDatabase.setFinality(streamConfig.finality);
		// TODO check if source matches old sync
		const lastSync = await this.db.get('lastSync');
		if (lastSync) {
			return {lastSync: lastSync as unknown as LastSync<ABI>, state: undefined};
		} else {
			return undefined;
		}
	}

	private processing: boolean | undefined;
	async process(eventStream: LogEvent<ABI>[], lastSync: LastSync<ABI>): Promise<void> {
		if (this.processing) {
			throw new Error(`processing...`);
		}
		this.processing = true;
		// console.log(`processing stream (nextStreamID: ${lastSync.nextStreamID})`)

		try {
			let lastBlock: number | undefined;
			let lastBlockDeleted: string | undefined;
			for (const event of eventStream) {
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
			await this.db.put(lastSyncDoc as any);
		} finally {
			this.processing = false;
		}
	}

	query<T>(request: Query | (Query & ({blockHash: string} | {blockNumber: number}))): Promise<Result> {
		if (('blockHash' in request && request.blockHash) || ('blockNumber' in request && request.blockNumber)) {
			return this.revertableDatabase.queryAtBlock(request as any);
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
