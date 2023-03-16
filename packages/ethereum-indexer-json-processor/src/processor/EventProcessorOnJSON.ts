import {
	IndexingSource,
	LastSync,
	LogEvent,
	Abi,
	EventProcessorWithInitialState,
	AllData,
	ExistingStateFecther,
	StateSaver,
	ProcessorContext,
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
	version?: string;
	createInitialState(): ProcessResultType;
	configure(config: ProcessorConfig): void;
	processEvent(json: ProcessResultType, event: LogEvent<ABI>): void;
};

export class EventProcessorOnJSON<ABI extends Abi, ProcessResultType extends JSObject, ProcessorConfig = undefined>
	implements EventProcessorWithInitialState<ABI, ProcessResultType, ProcessorConfig>
{
	protected state: ProcessResultType;
	protected _json: Partial<AllData<ABI, ProcessResultType, {history: HistoryJSObject}>>;
	protected history: History;
	protected existingStateFecther?: ExistingStateFecther<
		ABI,
		ProcessResultType,
		{history: HistoryJSObject},
		ProcessorConfig
	>;
	protected stateSaver?: StateSaver<ABI, ProcessResultType, {history: HistoryJSObject}, ProcessorConfig>;
	protected source: IndexingSource<ABI> | undefined;
	protected config: ProcessorConfig | undefined;
	protected version: string | undefined;
	constructor(private singleEventProcessor: SingleEventJSONProcessor<ABI, ProcessResultType, ProcessorConfig>) {
		this.version = singleEventProcessor.version;
		const data = singleEventProcessor.createInitialState();
		this._json = {
			data,
			lastSync: undefined,
			history: {
				blockHashes: {},
				reversals: {},
			},
		};
		this.history = new History(this._json.history, 12); // TODO finality
		this.state = proxifyJSON<ProcessResultType>(this._json.data, this.history);
	}

	getVersionHash(): string {
		return this.version + '_TODO_config'; // TODO config
	}

	createInitialState(): ProcessResultType {
		return this.singleEventProcessor.createInitialState();
	}

	configure(config: ProcessorConfig) {
		this.config = config;
		this.singleEventProcessor.configure(config);
	}

	keepState(config: {
		fetcher: ExistingStateFecther<ABI, ProcessResultType, {history: HistoryJSObject}, ProcessorConfig>;
		saver: StateSaver<ABI, ProcessResultType, {history: HistoryJSObject}, ProcessorConfig>;
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
			const config = this.config as ProcessorConfig;
			const version = this.version;
			// TODO why do we need the `as` ?
			const context = {source, config, version} as ProcessorContext<ABI, ProcessorConfig>;
			const existingStateData = await this.existingStateFecther(context);
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

		if (!this._json.lastSync) {
			return undefined;
		}
		return {lastSync: this._json.lastSync, state: this._json.data};
	}

	async process(eventStream: LogEvent<ABI>[], lastSync: LastSync<ABI>): Promise<ProcessResultType> {
		// namedLogger.log(`processing stream (nextStreamID: ${lastSync.nextStreamID})`)

		try {
			let lastBlock: number | undefined;
			let lastBlockHash: string | undefined;
			let lastBlockDeleted: string | undefined;
			for (const event of eventStream) {
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

					const willNotChange = lastSync.latestBlock - lastSync.lastToBlock > 16; // TODO finality
					const state = willNotChange ? this._json.data : this.state;
					this.singleEventProcessor.processEvent(state, event);
				}
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
				namedLogger.time('EventProcessorOnJSON.stateSaver');
				try {
					const config = this.config as ProcessorConfig;
					const source = this.source as IndexingSource<ABI>;
					const version = this.version;
					// TODO why do we need the `as` ?
					const context = {source, config, version} as ProcessorContext<ABI, ProcessorConfig>;
					if (!this._json.data || !this._json.lastSync || !this._json.history) {
						throw new Error(`empty _json`);
					}
					await this.stateSaver(context, this._json as AllData<ABI, ProcessResultType, {history: HistoryJSObject}>);
				} catch (e) {
					namedLogger.error(`failed to save ${e}`);
				}
				namedLogger.timeEnd('EventProcessorOnJSON.stateSaver');
			}
		} finally {
			// namedLogger.info(`EventProcessorOnJSON streamID: ${lastSync.nextStreamID}`);
		}

		if (!this._json.data) {
			throw new Error(`empty _json`);
		}
		return this._json.data;
	}
}
