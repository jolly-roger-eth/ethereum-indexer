import {IndexingSource, EventProcessor, EventWithId, LastSync, LogEvent, Abi} from 'ethereum-indexer';
import {logs} from 'named-logs';
import {History, HistoryJSObject, proxifyJSON} from './history';
import {EventFunctions, JSObject} from './types';

const namedLogger = logs('EventProcessorOnJSON');

export type AllData<ABI extends Abi, ProcessResultType extends JSObject> = {
	data: ProcessResultType;
	lastSync?: LastSync<ABI>;
	history: HistoryJSObject;
};

export type ExistingStateFecther<ABI extends Abi, ProcessResultType extends JSObject> = () => Promise<
	AllData<ABI, ProcessResultType>
>;
export type StateSaver<ABI extends Abi, ProcessResultType extends JSObject> = (
	data: AllData<ABI, ProcessResultType>
) => Promise<void>;

export type SingleEventJSONProcessor<ABI extends Abi, ProcessResultType extends JSObject> = EventFunctions<
	ABI,
	ProcessResultType
> & {
	setup?(json: ProcessResultType): Promise<void>;
	processEvent(json: ProcessResultType, event: EventWithId<ABI>): void;
	shouldFetchTimestamp?(event: LogEvent<ABI>): boolean;
	shouldFetchTransaction?(event: LogEvent<ABI>): boolean;
	filter?: (eventsFetched: LogEvent<ABI>[]) => Promise<LogEvent<ABI>[]>;
};

export class EventProcessorOnJSON<ABI extends Abi, ProcessResultType extends JSObject>
	implements EventProcessor<ABI, ProcessResultType>
{
	public readonly state: ProcessResultType;
	protected _json: AllData<ABI, ProcessResultType>;
	protected history: History;
	protected existingStateFecther?: ExistingStateFecther<ABI, ProcessResultType>;
	protected stateSaver?: StateSaver<ABI, ProcessResultType>;
	constructor(private singleEventProcessor: SingleEventJSONProcessor<ABI, ProcessResultType>) {
		this._json = {
			data: {} as ProcessResultType,
			history: {
				blockHashes: {},
				reversals: {},
			},
		};
		this.history = new History(this._json.history, 12); // TODO finality
		this.state = proxifyJSON<ProcessResultType>(this._json.data, this.history);
	}

	setExistingStateFetcher(fetcher: ExistingStateFecther<ABI, ProcessResultType>) {
		this.existingStateFecther = fetcher;
	}

	setStateSaver(saver: StateSaver<ABI, ProcessResultType>) {
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

	async load(source: IndexingSource<ABI>): Promise<LastSync<ABI>> {
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
		const lastSync = this.state.lastSync;
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
	async process(eventStream: EventWithId<ABI>[], lastSync: LastSync<ABI>): Promise<ProcessResultType> {
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

					this.singleEventProcessor.processEvent(this.state, event); // TODO check
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
		return this.state;
	}

	shouldFetchTimestamp(event: LogEvent<ABI>): boolean {
		return this.singleEventProcessor.shouldFetchTimestamp && this.singleEventProcessor.shouldFetchTimestamp(event);
	}

	shouldFetchTransaction(event: LogEvent<ABI>): boolean {
		return this.singleEventProcessor.shouldFetchTransaction && this.singleEventProcessor.shouldFetchTransaction(event);
	}
}
