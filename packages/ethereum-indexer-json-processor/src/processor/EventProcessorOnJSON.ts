import {
	IndexingSource,
	EventWithId,
	LastSync,
	LogEvent,
	Abi,
	EventProcessorWithInitialState,
	AllData,
	ExistingStateFecther,
	StateSaver,
} from 'ethereum-indexer';
import {logs} from 'named-logs';
import {History, HistoryJSObject, proxifyJSON} from './history';
import {EventFunctions, JSObject} from './types';

const namedLogger = logs('EventProcessorOnJSON');

export type SingleEventJSONProcessor<
	ABI extends Abi,
	ProcessResultType extends JSObject,
	ProcessorConfig = undefined
> = EventFunctions<ABI, ProcessResultType> & {
	createInitialState(): ProcessResultType;
	configure(config: ProcessorConfig): void;
	processEvent(json: ProcessResultType, event: EventWithId<ABI>): void;
	shouldFetchTimestamp?(event: LogEvent<ABI>): boolean;
	shouldFetchTransaction?(event: LogEvent<ABI>): boolean;
	filter?: (eventsFetched: LogEvent<ABI>[]) => Promise<LogEvent<ABI>[]>;
};

export class EventProcessorOnJSON<ABI extends Abi, ProcessResultType extends JSObject, ProcessorConfig = undefined>
	implements EventProcessorWithInitialState<ABI, ProcessResultType, ProcessorConfig>
{
	protected state: ProcessResultType;
	protected _json: AllData<ABI, ProcessResultType, {history: HistoryJSObject}>;
	protected history: History;
	protected existingStateFecther?: ExistingStateFecther<ABI, ProcessResultType, {history: HistoryJSObject}>;
	protected stateSaver?: StateSaver<ABI, ProcessResultType, {history: HistoryJSObject}>;
	protected source: IndexingSource<ABI> | undefined;
	constructor(private singleEventProcessor: SingleEventJSONProcessor<ABI, ProcessResultType, ProcessorConfig>) {
		const data = singleEventProcessor.createInitialState();
		this._json = {
			data,
			lastSync: {
				lastToBlock: 0,
				latestBlock: 0,
				nextStreamID: 1,
				unconfirmedBlocks: [],
			},
			history: {
				blockHashes: {},
				reversals: {},
			},
		};
		this.history = new History(this._json.history, 12); // TODO finality
		this.state = proxifyJSON<ProcessResultType>(this._json.data, this.history);
	}

	createInitialState(): ProcessResultType {
		return this.singleEventProcessor.createInitialState();
	}

	configure(config: ProcessorConfig) {
		this.singleEventProcessor.configure(config);
	}

	keepState(config: {
		fetcher: ExistingStateFecther<ABI, ProcessResultType, {history: HistoryJSObject}>;
		saver: StateSaver<ABI, ProcessResultType, {history: HistoryJSObject}>;
	}) {
		this.existingStateFecther = config.fetcher;
		this.stateSaver = config.saver;
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
		this._json.data = this.singleEventProcessor.createInitialState();
		this.state = proxifyJSON<ProcessResultType>(this._json.data, this.history);
	}

	async load(source: IndexingSource<ABI>): Promise<{lastSync: LastSync<ABI>; state: ProcessResultType}> {
		this.source = source;
		if (this.existingStateFecther) {
			const existingStateData = await this.existingStateFecther(source);
			if (existingStateData) {
				const {lastSync: lastSyncFromExistingState, data, history} = existingStateData;
				if (
					!this._json.lastSync?.lastToBlock ||
					// TODO configure 100
					Math.max(0, lastSyncFromExistingState.lastToBlock - this._json.lastSync?.lastToBlock || 0) > 100
				) {
					this._json.history = history;
					this.history.setBlock(0, '0x0000');

					const keys = Object.keys(this._json.data);
					for (const key of keys) {
						delete this._json.data[key];
					}
					this._json.data = data;
					this._json.lastSync = lastSyncFromExistingState;
					this.state = proxifyJSON<ProcessResultType>(this._json.data, this.history);
				}
			}
		}

		// TODO check if contractsData matches old sync
		const lastSync = this._json.lastSync || {
			lastToBlock: 0,
			latestBlock: 0,
			nextStreamID: 1,
			unconfirmedBlocks: [],
		};

		namedLogger.info(`nextStreamID: ${lastSync.nextStreamID}`);

		return {lastSync, state: this.state};
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
					await this.stateSaver(this.source, this._json);
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
