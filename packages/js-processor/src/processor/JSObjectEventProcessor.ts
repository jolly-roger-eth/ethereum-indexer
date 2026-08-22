import {
	IndexingSource,
	LastSync,
	LogEvent,
	Abi,
	assertProcessorVersion,
	EventProcessorWithInitialState,
	AllData,
	ProcessorContext,
	simple_hash,
	KeepState,
	UsedStreamConfig,
} from '@etherfold/core';
import {logs} from 'named-logs';
import {History, HistoryJSObject} from './history.js';
import {EventFunctions, JSObject} from './types.js';
import {Draft, Immer} from './immer.js';

// we do not auto freeze so we can reuse the raw state and modifiy it when needed (if events are known to be immutably included)
const immer = new Immer({autoFreeze: false});

const namedLogger = logs('JSObjectEventProcessor');

export type SingleEventJSONProcessor<
	ABI extends Abi,
	ProcessResultType extends JSObject,
	ProcessorConfig = undefined,
> = EventFunctions<ABI, ProcessResultType> & {
	/**
	 * REQUIRED. The identity of this processor's logic, and the only thing that
	 * makes the core discard state computed by a previous version. It used to be
	 * optional with an `unknown` fallback, so a processor whose author never
	 * declared a version looked exactly like an unchanged one, forever.
	 */
	version: string;
	createInitialState(): ProcessResultType;
	configure(config: ProcessorConfig): void;
	processEvent(json: ProcessResultType, event: LogEvent<ABI>): void | Promise<void>;
	/** The advisory fingerprint of the AUTHOR's handlers; see `EventProcessor.getCodeFingerprint`. */
	getCodeFingerprint?(): string | undefined;
};

export class JSObjectEventProcessor<
	ABI extends Abi,
	ProcessResultType extends JSObject,
	ProcessorConfig = undefined,
> implements EventProcessorWithInitialState<ABI, ProcessResultType, ProcessorConfig> {
	protected _json: Partial<AllData<ABI, ProcessResultType, {history: HistoryJSObject}>>;
	protected history: History;
	protected keeper?: KeepState<ABI, ProcessResultType, {history: HistoryJSObject}, ProcessorConfig>;
	protected source: IndexingSource<ABI> | undefined;
	protected config: ProcessorConfig | undefined;
	protected version: string;
	protected finality: number | undefined;
	constructor(private singleEventProcessor: SingleEventJSONProcessor<ABI, ProcessResultType, ProcessorConfig>) {
		// The backstop: `fromJSProcessor` checks the AUTHOR's object (where the handler
		// names make a better message), but this class is exported and can be handed a
		// hand-rolled `SingleEventJSONProcessor` that never went through it.
		assertProcessorVersion(singleEventProcessor, 'JSObjectEventProcessor');
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
		this.singleEventProcessor.configure(this.config as ProcessorConfig);
		this.finality = otherProcessor.finality; // this will be discarded on load
	}

	/**
	 * Identity of the processor's LOGIC, which is what invalidates stored state.
	 *
	 * There is no fallback constant anywhere in it, by construction. `version` is
	 * validated at construction, so the old `${version || 'unknown'}` has nothing
	 * left to fall back to. The config half is now hashed the SAME way whether or
	 * not `configure()` was ever called, rather than substituting a
	 * `'not-configured'` literal: an unconfigured processor and one configured
	 * with `undefined` are the same processor, and the old form gave them
	 * different hashes, discarding perfectly good state on the difference between
	 * a call that was made and a call that was not.
	 */
	getVersionHash(): string {
		return `${this.version}-${simple_hash({config: this.config})}`;
	}

	/** Advisory; see `EventProcessor.getCodeFingerprint`. Delegated to the author's own object. */
	getCodeFingerprint(): string | undefined {
		return this.singleEventProcessor.getCodeFingerprint?.();
	}

	createInitialState(): ProcessResultType {
		return this.singleEventProcessor.createInitialState();
	}

	configure(config: ProcessorConfig) {
		this.config = config;
		this.singleEventProcessor.configure(config);
	}

	keepState(keeper: KeepState<ABI, ProcessResultType, {history: HistoryJSObject}, ProcessorConfig>) {
		this.keeper = keeper;
	}

	async reset() {
		namedLogger.info('JSObjectEventProcessor reseting...');
		const state = this.singleEventProcessor.createInitialState();
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
		streamConfig: UsedStreamConfig,
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
						lastBlockDeleted = event.blockHash;
					}
				} else {
					if (willNotChange) {
						await this.singleEventProcessor.processEvent(this._json.state, event);
					} else {
						if (!lastBlockHash || event.blockHash != lastBlockHash) {
							if (draft as any) {
								const finalizedDraft = immer.finishDraft(draft as any, (_, reversePatches) => {
									this.history.setReversal(reversePatches);
								}) as ProcessResultType;
								this._json.state = finalizedDraft as unknown as ProcessResultType;
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
