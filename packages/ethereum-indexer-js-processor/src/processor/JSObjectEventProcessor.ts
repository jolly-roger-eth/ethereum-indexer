import {
	IndexingSource,
	LastSync,
	LogEvent,
	Abi,
	EventProcessorWithInitialState,
	AllData,
	ProcessorContext,
	simple_hash,
	KeepState,
	UsedStreamConfig,
} from 'ethereum-indexer';
import {logs} from 'named-logs';
import {History, HistoryJSObject} from './history';
import {EventFunctions, JSObject} from './types';
import {Draft, Immer} from './immer';

// we do not auto freeze so we can reuse the raw state and modifiy it when needed (if events are known to be immutably included)
const immer = new Immer({autoFreeze: false});

const namedLogger = logs('JSObjectEventProcessor');

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

export class JSObjectEventProcessor<ABI extends Abi, ProcessResultType extends JSObject, ProcessorConfig = undefined>
	implements EventProcessorWithInitialState<ABI, ProcessResultType, ProcessorConfig>
{
	protected _json: Partial<AllData<ABI, ProcessResultType, {history: HistoryJSObject}>>;
	protected history: History;
	protected keeper?: KeepState<ABI, ProcessResultType, {history: HistoryJSObject}, ProcessorConfig>;
	protected source: IndexingSource<ABI> | undefined;
	protected config: ProcessorConfig | undefined;
	protected version: string | undefined;
	protected configHash: string | undefined;
	protected finality: number | undefined;
	constructor(private singleEventProcessor: SingleEventJSONProcessor<ABI, ProcessResultType, ProcessorConfig>) {
		this.version = singleEventProcessor.version;
		const state = singleEventProcessor.createInitialState();
		const history = {
			blockHashes: {},
			reversals: {},
		};
		this._json = {
			state,
			lastSync: undefined,
			history,
		};
		this.history = new History(history);
	}

	copyFrom(otherProcessor: JSObjectEventProcessor<ABI, ProcessResultType, ProcessorConfig>) {
		this._json = otherProcessor._json;
		this.history = otherProcessor.history;
		this.keeper = otherProcessor.keeper;
		this.source = otherProcessor.source;
		this.config = otherProcessor.config;
		this.configHash = otherProcessor.configHash;
		this.singleEventProcessor.configure(this.config as ProcessorConfig);
		this.finality = otherProcessor.finality; // this will be discarded on load
	}

	getVersionHash(): string {
		return `${this.version || 'unknown'}-${this.configHash || 'not-configured'}`;
	}

	createInitialState(): ProcessResultType {
		return this.singleEventProcessor.createInitialState();
	}

	configure(config: ProcessorConfig) {
		this.config = config;
		this.singleEventProcessor.configure(config);
		this.configHash = simple_hash(this.config);
	}

	keepState(keeper: KeepState<ABI, ProcessResultType, {history: HistoryJSObject}, ProcessorConfig>) {
		this.keeper = keeper;
	}

	async reset() {
		namedLogger.info('JSObjectEventProcessor reseting...');
		const state = this.singleEventProcessor.createInitialState();
		const reset_frozen = Object.isFrozen(state);
		console.log({reset_frozen});
		this.version = this.singleEventProcessor.version;
		const history = {
			blockHashes: {},
			reversals: {},
		};
		this._json = {
			state,
			lastSync: undefined,
			history,
		};
		this.history = new History(history);
		if (this.finality) {
			this.history.setFinality(this.finality);
		}

		// return this._json.state;
	}

	async clear() {
		if (this.keeper) {
			const config = this.config as ProcessorConfig;
			const source = this.source as IndexingSource<ABI>;
			const version = this.version;
			const context = {source, config, version} as ProcessorContext<ABI, ProcessorConfig>;
			await this.keeper.clear(context);
		}
		return this.reset();
	}

	async load(
		source: IndexingSource<ABI>,
		streamConfig: UsedStreamConfig
	): Promise<{lastSync: LastSync<ABI>; state: ProcessResultType} | undefined> {
		this.finality = streamConfig.finality;
		this.history.setFinality(this.finality);
		this.source = source;
		if (this.keeper) {
			const config = this.config as ProcessorConfig;
			const version = this.version;
			const context = {source, config, version} as ProcessorContext<ABI, ProcessorConfig>;
			const existingStateData = await this.keeper.fetch(context);
			if (existingStateData) {
				const {lastSync: lastSyncFromExistingState, state, history} = existingStateData;
				if (
					!this._json.lastSync?.lastToBlock ||
					// TODO configure 100
					Math.max(0, lastSyncFromExistingState.lastToBlock - this._json.lastSync?.lastToBlock || 0) > 100
				) {
					this._json.history = history;
					this.history.setBlock(0, '0x0000');

					this._json.state = state;
					this._json.lastSync = lastSyncFromExistingState;
				}
			}
		}

		const loaded_frozen = Object.isFrozen(this._json.state);
		console.log({loaded_frozen});

		if (!this._json.lastSync) {
			return undefined;
		}
		if (!this._json.state) {
			throw new Error(`no data`);
		}
		return {lastSync: this._json.lastSync, state: this._json.state};
	}

	async process(eventStream: LogEvent<ABI>[], lastSync: LastSync<ABI>): Promise<ProcessResultType> {
		let draft: Draft<ProcessResultType> | undefined;
		// namedLogger.log(`processing stream (nextStreamID: ${lastSync.nextStreamID})`)
		if (!this.finality) {
			throw new Error(`finality not set`);
		}
		if (!this._json.state) {
			throw new Error(`no data`);
		}
		const willNotChange = lastSync.latestBlock - lastSync.lastToBlock > this.finality;
		try {
			let lastBlock: number | undefined;
			let lastBlockHash: string | undefined;
			let lastBlockDeleted: string | undefined;

			for (const event of eventStream) {
				if (event.removed) {
					namedLogger.info(`JSObjectEventProcessor event removed....`);

					if (!lastBlockDeleted || event.blockHash != lastBlockDeleted) {
						namedLogger.info(`JSObjectEventProcessor preparing block...`);
						this._json.state = this.history.reverseBlock(event.blockNumber, event.blockHash, this._json.state);

						const removed_frozen = Object.isFrozen(this._json.state);
						console.log({removed_frozen});
						lastBlockDeleted = event.blockHash;
					}
				} else {
					if (willNotChange) {
						this.singleEventProcessor.processEvent(this._json.state, event);
					} else {
						if (!lastBlockHash || event.blockHash != lastBlockHash) {
							if (draft as any) {
								const finalizedDraft = immer.finishDraft(draft as any, (_, reversePatches) => {
									this.history.setReversal(reversePatches);
								}) as ProcessResultType;
								this._json.state = finalizedDraft as unknown as ProcessResultType;
								const finalized_frozen = Object.isFrozen(this._json.state);
								console.log({finalized_frozen});
							}

							this.history.setBlock(event.blockNumber, event.blockHash);
							lastBlock = event.blockNumber;
							lastBlockHash = event.blockHash;

							draft = immer.createDraft(this._json.state) as Draft<ProcessResultType>;
						}

						this.singleEventProcessor.processEvent(draft as any, event);
					}
				}
			}

			if (draft as any) {
				const finalizedDraft = immer.finishDraft(draft as any, (_, reversePatches) => {
					this.history.setReversal(reversePatches);
				}) as ProcessResultType;
				this._json.state = finalizedDraft;

				const final_finalized_frozen = Object.isFrozen(this._json.state);
				console.log({final_finalized_frozen});
			}

			let lastLastSync;
			try {
				lastLastSync = this._json.lastSync;
			} catch (err) {}
			const lastSyncDoc = {
				_id: 'lastSync',
				_rev: (lastLastSync as any)?._rev,
				...lastSync,
			};
			this._json.lastSync = lastSyncDoc;

			if (this.keeper) {
				// namedLogger.time('JSObjectEventProcessor.stateSaver');
				try {
					const config = this.config as ProcessorConfig;
					const source = this.source as IndexingSource<ABI>;
					const version = this.version;
					const context = {source, config, version} as ProcessorContext<ABI, ProcessorConfig>;
					if (!this._json.state || !this._json.lastSync || !this._json.history) {
						throw new Error(`empty _json`);
					}
					await this.keeper.save(context, this._json as AllData<ABI, ProcessResultType, {history: HistoryJSObject}>);
				} catch (e) {
					namedLogger.error(`failed to save ${e}`);
				}
				// namedLogger.timeEnd('JSObjectEventProcessor.stateSaver');
			}
		} finally {
			// namedLogger.info(`JSObjectEventProcessor streamID: ${lastSync.nextStreamID}`);
		}

		if (!this._json.state) {
			throw new Error(`empty _json`);
		}
		return this._json.state;
	}
}
