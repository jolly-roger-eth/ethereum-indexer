import {IndexingSource, EventProcessor, LastSync, LogEvent, Abi, LogEventWithParsingFailure} from 'ethereum-indexer';
import {logs} from 'named-logs';
import {JSONObject, Database, FromDB, Query, Result} from './Database';
import {RevertableDatabase} from './RevertableDatabase';
import {BasicSyncDB, SyncDB} from './SyncDB';

const console = logs('EventProcessorWithBatchDBUpdate');

export type Dependency = string | {id: string; nextID: (entity: any) => string};

function mergeDependenciesIn(dependencies: Dependency[], deps: Dependency[]) {
	const alreadyIn: {[id: string]: boolean} = {};
	for (const dep of dependencies) {
		if (typeof dep === 'string') {
			alreadyIn[dep] = true;
		}
	}
	for (const dep of deps) {
		if (typeof dep === 'string') {
			if (!alreadyIn[dep]) {
				dependencies.push(dep);
				alreadyIn[dep] = true;
			}
		} else {
			dependencies.push(dep);
		}
	}
}

// TODO
// is this something like taht possible ?
export type OnFunction = `on${string}`;

export type SingleEventProcessorWithBatchSupport<ABI extends Abi> = {
	setup?(db: Database): Promise<void>;
} & {
	[name: OnFunction]: {
		dependencies(event: LogEvent<ABI>): Dependency[];
		processEvent(db: SyncDB, event: LogEvent<ABI>): void;
	};
	handleUnparsedEvent?(event: LogEventWithParsingFailure): void;
	getVersionHash(): string;
};

export class EventProcessorWithBatchDBUpdate<ABI extends Abi> implements EventProcessor<ABI, void> {
	private initialization: Promise<void> | undefined;
	private revertableDatabase: RevertableDatabase<ABI>;
	private keepAllHistory: boolean;
	constructor(private singleEventProcessor: SingleEventProcessorWithBatchSupport<ABI>, protected db: Database) {
		this.initialization = this.init();
		this.keepAllHistory = false; // this allow time-travel queries but requires processing and will not scale
		this.revertableDatabase = new RevertableDatabase(db, this.keepAllHistory);
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

	async load(source: IndexingSource<ABI>): Promise<{lastSync: LastSync<ABI>; state: void} | undefined> {
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
			const revertable = this.keepAllHistory || lastSync.latestBlock - lastSync.lastToBlock <= 12; // TODO finality from indexer

			// ----------------------------------------------------------------------------------------------------------------
			// TODO copy that on all processors
			//  This could technically be moved into `ethereum-indexer`
			//  but feels like the indexer should just give a stream and not care of this
			let firstRemoval: number | undefined;
			for (let i = 0; i < eventStream.length; i++) {
				const event = eventStream[i];
				if (event.removed) {
					firstRemoval = i;
					break;
				}
			}

			if (firstRemoval !== undefined) {
				for (let i = firstRemoval; i >= 0; i--) {
					const removedEvent = eventStream[firstRemoval + (firstRemoval - i)];
					const event = eventStream[i];
					if (event.logIndex !== removedEvent.logIndex || event.transactionHash !== removedEvent.transactionHash) {
						throw new Error(`removed event not matching event`);
					}
				}
				eventStream.splice(0, 2 * (firstRemoval + 1));
			}
			// ----------------------------------------------------------------------------------------------------------------

			let i = 0;
			while (eventStream[i] && eventStream[i].removed) {
				// TODO
				//  handle revert of past saved data
				//  handle case where it has already been handled
				//  (for example, cannot find any entity with the eventID (logIndex/transactionHash))

				// copied from before
				// if (!lastBlockDeleted || event.blockHash != lastBlockDeleted) {
				//   console.info(`EventProcessorOnDatabase preparing block...`);
				//   await this.revertableDatabase.deleteBlock({ hash: event.blockHash, number: event.blockNumber });
				//   lastBlockDeleted = event.blockHash;
				// }

				// await this.revertableDatabase.remove(event);

				i++;
			}

			if (!revertable) {
				const syncDB = new BasicSyncDB<ABI>(this.db);
				// ----------------------------------------------------------------------------------------------------------------
				// Compute dependencies (Entities required to compute next state)
				// ----------------------------------------------------------------------------------------------------------------
				const dependencies: Dependency[] = [];
				for (const event of eventStream) {
					if ('decodeError' in event) {
						continue;
					}
					const functionName = `on${event.eventName}`;
					const singleEventProcessor = this.singleEventProcessor as any;
					if (singleEventProcessor[functionName] && singleEventProcessor[functionName].dependencies) {
						const deps = singleEventProcessor[functionName].dependencies(event);
						mergeDependenciesIn(dependencies, deps);
					}
				}

				// ----------------------------------------------------------------------------------------------------------------
				// Fetch dependencies
				// ----------------------------------------------------------------------------------------------------------------
				await syncDB.fetch(dependencies);

				// ----------------------------------------------------------------------------------------------------------------
				// Compute new State
				// ----------------------------------------------------------------------------------------------------------------
				for (const event of eventStream) {
					syncDB.prepareEvent(event);
					if ('decodeError' in event) {
						if ('handleUnparsedEvent' in this.singleEventProcessor && this.singleEventProcessor.handleUnparsedEvent) {
							this.singleEventProcessor.handleUnparsedEvent(event);
						}
					} else {
						const functionName = `on${event.eventName}`;
						const singleEventProcessor = this.singleEventProcessor as any;
						if (singleEventProcessor[functionName] && singleEventProcessor[functionName].processEvent) {
							singleEventProcessor[functionName].processEvent(syncDB, event);
						}
					}
				}
				// ----------------------------------------------------------------------------------------------------------------
				// Sync DB
				// ----------------------------------------------------------------------------------------------------------------
				await syncDB.syncUp();
			} else {
				const syncDB = new BasicSyncDB<ABI>(this.revertableDatabase);
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

						syncDB.prepareEvent(event);

						if ('decodeError' in event) {
							if ('handleUnparsedEvent' in this.singleEventProcessor && this.singleEventProcessor.handleUnparsedEvent) {
								this.singleEventProcessor.handleUnparsedEvent(event);
								await syncDB.syncUp();
							}
						} else {
							// could optimize per block
							const functionName = `on${event.eventName}`;
							const singleEventProcessor = this.singleEventProcessor as any;
							if (singleEventProcessor[functionName]) {
								if (singleEventProcessor[functionName].dependencies) {
									const dependencies: Dependency[] = singleEventProcessor[functionName].dependencies(event);
									await syncDB.fetch(dependencies);
								}
								singleEventProcessor[functionName].processEvent(syncDB, event);
								await syncDB.syncUp();
							}
						}
						console.info(`EventProcessorOnDatabase DONE`);
					}

					if (lastBlock) {
						await this.revertableDatabase.postBlock(lastBlock);
					}

					if (!this.initialization) {
						break; // stop
					}
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
