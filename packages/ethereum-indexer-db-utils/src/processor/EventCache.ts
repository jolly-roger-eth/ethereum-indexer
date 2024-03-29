import {IndexingSource, EventProcessor, LastSync, LogEvent, Abi, UsedStreamConfig} from 'ethereum-indexer';
import {logs} from 'named-logs';
import {Database, FromDB, JSONObject, Query, Result} from '../db/Database';
const console = logs('EventCache');

function lexicographicNumber15(num: number): string {
	return num.toString().padStart(15, '0');
}

export class EventCache<ABI extends Abi, ProcessResultType> implements EventProcessor<ABI, ProcessResultType> {
	protected eventDB: Database;
	protected initialization: Promise<void> | undefined;
	constructor(protected processor: EventProcessor<ABI, ProcessResultType>, database: Database) {
		this.eventDB = database;
		this.initialization = this.init();
	}

	getVersionHash(): string {
		return this.processor.getVersionHash();
	}

	protected init(): Promise<void> {
		this.initialization = this.eventDB.setup({
			indexes: [{fields: ['batch', 'blockNumber', 'logIndex']}], // 'blockNumber', 'blockHash', 'address', 'transactionHash', 'name', 'signature', 'topic'
		});
		return this.initialization;
	}

	async reset() {
		await this.processor.reset();
		this.initialization = undefined;
		await this.init();
	}

	async clear() {
		await this.processor.clear();
		this.eventDB = await this.eventDB.reset();

		this.initialization = undefined;
		await this.init();
	}

	async load(
		source: IndexingSource<ABI>,
		streamConfig: UsedStreamConfig
	): Promise<{lastSync: LastSync<ABI>; state: ProcessResultType} | undefined> {
		const lastSyncFromProcessor = await this.processor.load(source, streamConfig);
		if (lastSyncFromProcessor) {
			return lastSyncFromProcessor;
		}
		try {
			const lastSync = await this.eventDB.get<LastSync<ABI> & {batch: number}>('lastSync');
			if (!lastSync) {
				return undefined;
			}
			this.batchCounter = lastSync.batch;

			const outcome = await this.replay();
			if (outcome) {
				return {lastSync, state: outcome};
			} else {
				return undefined;
			}
		} catch (err) {
			return undefined;
		}
	}

	protected _replaying: boolean | undefined;
	async replay(): Promise<ProcessResultType | undefined> {
		let lastOutcome: ProcessResultType | undefined;

		if (this._replaying) {
			throw new Error(`already replaying`);
		}
		this._replaying = true;
		try {
			console.info('EventChache reseting processor ...');
			await this.processor.reset();
			console.info('EventChache ...done');

			const lastSync = (await this.eventDB.get('lastSync')) as LastSync<ABI> & {batch: number};
			console.info(
				`EventCache lastSync`,
				JSON.stringify(
					lastSync,
					(_, value) => (typeof value === 'bigint' ? value.toString() : value), // return everything else unchanged)}
					2
				)
			);

			for (let i = 0; i < lastSync.batch; i++) {
				const events = (
					await this.eventDB.query({
						selector: {
							batch: i,
						},
					})
				).docs
					.filter((v) => v._id !== 'lastSync')
					.sort((a, b) => {
						const aT = a.blockNumber;
						const bT = b.blockNumber;
						if (aT > bT) {
							return 1;
						} else if (aT < bT) {
							return -1;
						} else {
							const aL = a.logIndex;
							const bL = b.logIndex;
							if (aL > bL) {
								return 1;
							} else if (aL < bL) {
								return -1;
							} else {
								return 0;
							}
						}
					}) as unknown as LogEvent<ABI>[];
				if (events.length > 0) {
					// TODO allow replay to fetch timestamp if missing
					for (const event of events) {
						// TODO also shouldFetchTransaction
						// if (!event.blockTimestamp && this.processor.shouldFetchTimestamp(event)) {
						//   // TODO
						// }
					}

					const lastEvent = events[events.length - 1];
					console.info(`EventCache replaying batch ${i}...`);
					lastOutcome = await this.processor.process(events, {
						context: lastSync.context,
						lastFromBlock: lastSync.lastToBlock + 1,
						lastToBlock: lastEvent.blockNumber,
						latestBlock: lastEvent.blockNumber,
						unconfirmedBlocks: [],
					});
					console.info(`EventCache ...done`);
				}
			}
		} catch (err) {
			console.error({
				err,
			});
		}

		this._replaying = false;
		return lastOutcome;
	}

	protected batchCounter = 0;
	async process(eventStream: LogEvent<ABI>[], lastSync: LastSync<ABI>): Promise<ProcessResultType> {
		console.info(`EventCache enter processing.`);
		await this.initialization;

		if (this._replaying) {
			throw new Error(`please wait while replaying is taking place`);
		}
		console.info(`EventCache processing...`);
		const outcome = await this.processor.process(eventStream, lastSync);
		if (eventStream.length > 0) {
			for (const event of eventStream) {
				await this.eventDB.put({
					_id: event.blockHash + event.logIndex,
					transactionHash: event.transactionHash,
					logIndex: event.logIndex,
					blockNumber: event.blockNumber,
					blockHash: event.blockHash,
					transactionIndex: event.transactionIndex,
					topics: event.topics,
					removed: event.removed,
					address: event.address,
					eventName: (event as any).eventName,
					data: event.data,
					args: (event as any).args,
					// extra: event.extra, // TODO
					batch: this.batchCounter,
				});
			}
			this.batchCounter++;
		} else {
			console.info(`EventCache no events`);
		}

		let lastLastSync;
		try {
			lastLastSync = await this.eventDB.get('lastSync');
		} catch (err) {}
		const lastSyncDoc = {
			_id: 'lastSync',
			_rev: lastLastSync?._rev,
			...lastSync,
			batch: this.batchCounter,
		};

		// console.log(`lastSync document`)
		// console.log(JSON.stringify(lastSyncDoc, null, 2))
		await this.eventDB.put(lastSyncDoc as any);

		return outcome;
	}

	query<T>(request: Query | (Query & ({blockHash: string} | {blockNumber: number}))): Promise<Result> {
		return this.eventDB.query(request);
	}

	get<T extends JSONObject>(id: string): Promise<FromDB<T> | null> {
		return this.eventDB.get(id);
	}
}
