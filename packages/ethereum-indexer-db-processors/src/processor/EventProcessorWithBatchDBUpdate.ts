import {ContractsInfo, EventProcessor, EventWithId, LastSync, LogEvent} from 'ethereum-indexer';
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

export type SingleEventProcessorWithBatchSupport = {
	setup?(db: Database): Promise<void>;
	shouldFetchTimestamp?(event: LogEvent): boolean;
	shouldFetchTransaction?(event: LogEvent): boolean;
	filter?: (eventsFetched: LogEvent[]) => Promise<LogEvent[]>;
} & {
	[name: OnFunction]: {
		dependencies(event: EventWithId): Dependency[];
		processEvent(db: SyncDB, event: EventWithId);
	};
};

export class EventProcessorWithBatchDBUpdate implements EventProcessor {
	private initialization: Promise<void> | undefined;
	private revertableDatabase: RevertableDatabase;
	private keepAllHistory: boolean;
	constructor(private singleEventProcessor: SingleEventProcessorWithBatchSupport, protected db: Database) {
		this.initialization = this.init();
		this.keepAllHistory = false; // this allow time-travel queries but requires processing and will not scale
		this.revertableDatabase = new RevertableDatabase(db, this.keepAllHistory);
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

	async load(contractsData: ContractsInfo): Promise<LastSync> {
		// TODO check if contractsData matches old sync
		const lastSync = await this.db.get('lastSync');
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
	private processing: boolean;
	async process(eventStream: EventWithId[], lastSync: LastSync): Promise<void> {
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
				const syncDB = new BasicSyncDB(this.db);
				// ----------------------------------------------------------------------------------------------------------------
				// Compute dependencies (Entities required to compute next state)
				// ----------------------------------------------------------------------------------------------------------------
				const dependencies: Dependency[] = [];
				for (const event of eventStream) {
					const functionName = `on${event.name}`;
					if (this.singleEventProcessor[functionName] && this.singleEventProcessor[functionName].dependencies) {
						const deps = this.singleEventProcessor[functionName].dependencies(event);
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
					const functionName = `on${event.name}`;
					syncDB.prepareEvent(event);
					if (this.singleEventProcessor[functionName] && this.singleEventProcessor[functionName].processEvent) {
						this.singleEventProcessor[functionName].processEvent(syncDB, event);
					}
				}
				// ----------------------------------------------------------------------------------------------------------------
				// Sync DB
				// ----------------------------------------------------------------------------------------------------------------
				await syncDB.syncUp();
			} else {
				const syncDB = new BasicSyncDB(this.revertableDatabase);
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

						syncDB.prepareEvent(event);

						// could optimize per block
						const functionName = `on${event.name}`;
						if (this.singleEventProcessor[functionName]) {
							if (this.singleEventProcessor[functionName].dependencies) {
								const dependencies: Dependency[] = this.singleEventProcessor[functionName].dependencies(event);
								await syncDB.fetch(dependencies);
							}
							this.singleEventProcessor[functionName].processEvent(syncDB, event);
							await syncDB.syncUp();
						}
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

	shouldFetchTimestamp(event: LogEvent): boolean {
		return this.singleEventProcessor.shouldFetchTimestamp && this.singleEventProcessor.shouldFetchTimestamp(event);
	}

	shouldFetchTransaction(event: LogEvent): boolean {
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
