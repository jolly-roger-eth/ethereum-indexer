import {IndexingSource, EventProcessor, EventWithId, LastSync, LogEvent} from 'ethereum-indexer';
import {logs} from 'named-logs';
import {History, HistoryJSObject, proxifyJSON} from './history';
import {JSObject} from './types';

const namedLogger = logs('EventProcessorOnJSON');

export type AllData<T extends JSObject> = {data: T; lastSync?: LastSync; history: HistoryJSObject};

export type ExistingStateFecther<T extends JSObject> = () => Promise<AllData<T>>;
export type StateSaver<T extends JSObject> = (data: AllData<T>) => Promise<void>;

export interface SingleEventJSONProcessor<T extends JSObject> {
	setup?(json: T): Promise<void>;
	processEvent(json: T, event: EventWithId): void;
	shouldFetchTimestamp?(event: LogEvent): boolean;
	shouldFetchTransaction?(event: LogEvent): boolean;
	filter?: (eventsFetched: LogEvent[]) => Promise<LogEvent[]>;
}

export class EventProcessorOnJSON<T extends JSObject> implements EventProcessor {
	public readonly json: T;
	protected _json: AllData<T>;
	protected history: History;
	protected existingStateFecther?: ExistingStateFecther<T>;
	protected stateSaver?: StateSaver<T>;
	constructor(private singleEventProcessor: SingleEventJSONProcessor<T>) {
		this._json = {
			data: {} as T,
			history: {
				blockHashes: {},
				reversals: {},
			},
		};
		this.history = new History(this._json.history, 12); // TODO finality
		this.json = proxifyJSON<T>(this._json.data, this.history);
	}

	setExistingStateFetcher(fetcher: ExistingStateFecther<T>) {
		this.existingStateFecther = fetcher;
	}

	setStateSaver(saver: StateSaver<T>) {
		this.stateSaver = saver;
	}

	async reset() {
		namedLogger.info('EventProcessorOnJSON reseting...');
		const keys = Object.keys(this._json.data);
		for (const key of keys) {
			delete this._json.data[key];
		}
		this._json.history = {
			blockHashes: {},
			reversals: {},
		};
		this.history.setBlock(0, '0x0000');
		await this.singleEventProcessor.setup(this._json.data);
	}

	async load(source: IndexingSource): Promise<LastSync> {
		if (this.existingStateFecther) {
			namedLogger.info(`fetching state...`);
			const {lastSync: lastSyncFromExistingState, data, history} = await this.existingStateFecther();
			if (
				!this._json.lastSync?.lastToBlock ||
				// TODO configure 100
				Math.max(0, lastSyncFromExistingState.lastToBlock - this._json.lastSync?.lastToBlock || 0) > 100
			) {
				this._json.history = history;
				this.history.setBlock(0, '0x0000');

				this._json.data = data;
				this._json.lastSync = lastSyncFromExistingState;
			}
		}

		namedLogger.info(`EventProcessorOnJSON SETTING UP....`);
		await this.singleEventProcessor.setup(this._json.data);

		// TODO check if contractsData matches old sync
		const lastSync = this.json.lastSync;
		if (lastSync) {
			return lastSync as unknown as LastSync;
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
	async process(eventStream: EventWithId[], lastSync: LastSync): Promise<void> {
		// namedLogger.log(`processing stream (nextStreamID: ${lastSync.nextStreamID})`)

		try {
			let lastBlock: number | undefined;
			let lastBlockHash: string | undefined;
			let lastBlockDeleted: string | undefined;
			for (const event of eventStream) {
				if (this.lastEventID && event.streamID <= this.lastEventID) {
					continue;
				}
				if (event.removed) {
					namedLogger.info(`EventProcessorOnJSON event removed....`);

					if (!lastBlockDeleted || event.blockHash != lastBlockDeleted) {
						namedLogger.info(`EventProcessorOnJSON preparing block...`);
						this.history.reverseBlock(event.blockNumber, event.blockHash, this._json.data);
						lastBlockDeleted = event.blockHash;
					}
				} else {
					if (!lastBlockHash || event.blockHash != lastBlockHash) {
						this.history.setBlock(event.blockNumber, event.blockHash);
						lastBlock = event.blockNumber;
						lastBlockHash = event.blockHash;
					}

					this.singleEventProcessor.processEvent(this.json, event);
					// namedLogger.info(`EventProcessorOnJSON DONE`);
				}
				this.lastEventID = event.streamID;
			}
			let lastLastSync;
			try {
				lastLastSync = this._json.lastSync;
			} catch (err) {}
			const lastSyncDoc = {
				_id: 'lastSync',
				_rev: lastLastSync?._rev,
				...lastSync,
			};
			this._json.lastSync = lastSyncDoc;
			if (this.stateSaver) {
				try {
					await this.stateSaver(this._json);
				} catch (e) {
					namedLogger.error(`failed to save ${e}`);
				}
			}
		} finally {
			namedLogger.info(`EventProcessorOnJSON streamID: ${lastSync.nextStreamID}`);
		}
	}

	shouldFetchTimestamp(event: LogEvent): boolean {
		return this.singleEventProcessor.shouldFetchTimestamp && this.singleEventProcessor.shouldFetchTimestamp(event);
	}

	shouldFetchTransaction(event: LogEvent): boolean {
		return this.singleEventProcessor.shouldFetchTransaction && this.singleEventProcessor.shouldFetchTransaction(event);
	}
}
