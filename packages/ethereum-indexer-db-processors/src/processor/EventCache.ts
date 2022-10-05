import {ContractsInfo, EventProcessor, EventWithId, LastSync, LogEvent} from 'ethereum-indexer';
import {logs} from 'named-logs';
import {Database, FromDB, JSONObject, Query, Result} from './Database';
const console = logs('EventCache');

function lexicographicNumber15(num: number): string {
	return num.toString().padStart(15, '0');
}

export class EventCache implements EventProcessor {
	protected eventDB: Database;
	protected initialization: Promise<void> | undefined;
	constructor(protected processor: EventProcessor, database: Database) {
		this.eventDB = database;
		this.initialization = this.init();
	}

	protected init(): Promise<void> {
		this.initialization = this.eventDB.setup({
			indexes: [{fields: ['batch']}], // 'blockNumber', 'blockHash', 'address', 'transactionHash', 'name', 'signature', 'topic'
		});
		return this.initialization;
	}

	async reset() {
		await this.processor.reset();
		this.eventDB = await this.eventDB.reset();

		this.initialization = undefined;
		await this.init();
	}

	async load(contractsData: ContractsInfo): Promise<LastSync> {
		// TODO check if contractsData matches old sync
		try {
			const lastSync = await this.eventDB.get<LastSync & {batch: number}>('lastSync');
			this.batchCounter = lastSync.batch;
			return lastSync as unknown as LastSync;
		} catch (err) {
			return {
				lastToBlock: 0,
				latestBlock: 0,
				nextStreamID: 1,
				unconfirmedBlocks: [],
			};
		}
	}

	protected _replaying: boolean;
	async replay() {
		if (this._replaying) {
			throw new Error(`already replaying`);
		}
		this._replaying = true;
		try {
			console.info('EventChache reseting processor ...');
			await this.processor.reset();
			console.info('EventChache ...done');

			const lastSync = (await this.eventDB.get('lastSync')) as LastSync & {batch: number};
			console.info(`EventCache lastSync`, JSON.stringify(lastSync, null, 2));
			for (let i = 0; i < lastSync.batch; i++) {
				const events = (
					await this.eventDB.query({
						selector: {
							batch: i,
						},
						sort: ['_id'],
					})
				).docs.filter((v) => v._id !== 'lastSync') as unknown as EventWithId[];
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
					await this.processor.process(events, {
						lastToBlock: lastEvent.blockNumber,
						latestBlock: lastEvent.blockNumber,
						nextStreamID: lastEvent.streamID + 1,
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
	}

	protected batchCounter = 0;
	async process(eventStream: EventWithId[], lastSync: LastSync): Promise<void> {
		console.info(`EventCache enter processing.`);
		await this.initialization;

		if (this._replaying) {
			throw new Error(`please wait while replaying is taking place`);
		}
		console.info(`EventCache processing...`);
		await this.processor.process(eventStream, lastSync);
		if (eventStream.length > 0) {
			for (const event of eventStream) {
				await this.eventDB.put({
					_id: lexicographicNumber15(event.streamID),
					streamID: event.streamID, // TODO remove ?
					transactionHash: event.transactionHash,
					logIndex: event.logIndex,
					blockNumber: event.blockNumber,
					blockHash: event.blockHash,
					transactionIndex: event.transactionIndex,
					topics: event.topics,
					removed: event.removed,
					address: event.address,
					name: event.name,
					data: event.data,
					topic: event.topic,
					signature: event.signature,
					args: event.args,
					extra: event.extra,
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

		console.info(`nextStreamID: ${lastSync.nextStreamID}`);

		// console.log(`lastSync document`)
		// console.log(JSON.stringify(lastSyncDoc, null, 2))
		await this.eventDB.put(lastSyncDoc);
	}

	shouldFetchTimestamp(event: LogEvent): boolean {
		return this.processor.shouldFetchTimestamp && this.processor.shouldFetchTimestamp(event);
	}

	shouldFetchTransaction(event: LogEvent): boolean {
		return this.processor.shouldFetchTransaction && this.processor.shouldFetchTransaction(event);
	}

	async filter(eventsFetched: LogEvent[]): Promise<LogEvent[]> {
		return this.processor.filter ? this.processor.filter(eventsFetched) : eventsFetched;
	}

	query<T>(request: Query | (Query & ({blockHash: string} | {blockNumber: number}))): Promise<Result> {
		return this.eventDB.query(request);
	}

	get<T extends JSONObject>(id: string): Promise<FromDB<T> | null> {
		return this.eventDB.get(id);
	}
}
