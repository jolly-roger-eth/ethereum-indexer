import {ContractsInfo, EventProcessor, EventWithId, LastSync, LogEvent} from 'ethereum-indexer';
import fs from 'fs';
import path from 'path';
import {logs} from 'named-logs';
import {lexicographicNumber15} from './utils';
const namedLogger = logs('EventListFSStore');

function identity(arg: any): any {
	return arg;
}

export class ProcessorFilesystemCache implements EventProcessor {
	protected folder: string;
	constructor(protected processor: EventProcessor, folder: string) {
		this.folder = path.join(folder, 'logs');
		try {
			fs.mkdirSync(this.folder, {recursive: true});
		} catch (err) {}
	}

	async reset() {
		try {
			namedLogger.info(`EventListFSStore: reseting...`);
			await this.processor.reset();
			fs.rmSync(this.folder, {recursive: true});
			fs.mkdirSync(this.folder, {recursive: true});
		} catch (err) {
			namedLogger.error(`failed to reset : ${err}`);
		}
	}

	async load(contractsData: ContractsInfo): Promise<LastSync> {
		let lastSync: LastSync;
		try {
			const content = fs.readFileSync(this.folder + `/lastSync.json`, 'utf8');
			lastSync = JSON.parse(content);
		} catch (err) {
			lastSync = {
				lastToBlock: 0,
				latestBlock: 0,
				nextStreamID: 1,
				unconfirmedBlocks: []
			};
		}

		// TODO check if contractsData matches old sync
		let lastSyncFromProcessor: LastSync = await this.processor.load(contractsData);

		const files = fs.readdirSync(this.folder);
		namedLogger.info(`loading ${files} files of events...`);
		const eventFiles = files.filter((v: string) => v.startsWith('events_'));
		if (eventFiles.length > 0) {
			for (const file of eventFiles) {
				const eventStream: EventWithId[] = JSON.parse(fs.readFileSync(`${this.folder}/${file}`).toString());
				const maxBatchSize = 128;

				if (eventStream.length > maxBatchSize) {
					namedLogger.info(`eventStream size bigger than ${maxBatchSize} : ${eventStream.length}`);
					for (let i = 0; i < eventStream.length; i += maxBatchSize) {
						const subStream: EventWithId[] = eventStream.slice(i, i + maxBatchSize);
						namedLogger.info(`sending ${subStream.length} (from ${i} to ${i + maxBatchSize - 1})`);
						if (lastSyncFromProcessor.nextStreamID === subStream[0].streamID) {
							lastSyncFromProcessor = {
								lastToBlock: subStream[subStream.length - 1].blockNumber,
								latestBlock: lastSync.latestBlock,
								nextStreamID: subStream[subStream.length - 1].streamID + 1,
								unconfirmedBlocks: [] // TODO ?
							};
							namedLogger.info('processing substream...');
							await this.processor.process(subStream, lastSyncFromProcessor);
						} else {
							namedLogger.info(
								`skip as streamID do not match (processor : ${lastSyncFromProcessor.nextStreamID}, cache: ${subStream[0].streamID})`
							);
						}
					}
				} else {
					if (lastSyncFromProcessor.nextStreamID === eventStream[0].streamID) {
						lastSyncFromProcessor = {
							lastToBlock: eventStream[eventStream.length - 1].blockNumber,
							latestBlock: lastSync.latestBlock,
							nextStreamID: eventStream[eventStream.length - 1].streamID + 1,
							unconfirmedBlocks: [] // TODO ?
						};
						namedLogger.info('processing stream...');
						await this.processor.process(eventStream, lastSyncFromProcessor);
					} else {
						namedLogger.info(
							`skip as streamID do not match (processor : ${lastSyncFromProcessor.nextStreamID}, cache: ${eventStream[0].streamID})`
						);
					}
				}
			}
		}

		if (lastSync.nextStreamID !== lastSyncFromProcessor.nextStreamID) {
			throw new Error(`
last sync not matching between cache and the processor, please investigate
CACHE:
${JSON.stringify(lastSync, null, 2)}

PROCESSOR:
${JSON.stringify(lastSyncFromProcessor, null, 2)}
`);
		}
		return lastSync;
	}

	async process(eventStream: EventWithId[], lastSync: LastSync): Promise<void> {
		await this.processor.process(eventStream, lastSync);
		if (eventStream.length > 0) {
			const filename = `events_${lexicographicNumber15(eventStream[0].streamID)}_${lexicographicNumber15(
				eventStream[eventStream.length - 1].streamID
			)}.json`;

			fs.writeFileSync(this.folder + `/${filename}`, JSON.stringify(eventStream, null, 2));
		}
		fs.writeFileSync(this.folder + `/lastSync.json`, JSON.stringify(lastSync));
		namedLogger.info(`EventListFSStore streamID: ${lastSync.nextStreamID}`);
	}

	filter(eventsFetched: LogEvent[]): Promise<LogEvent[]> {
		return this.processor.filter ? this.processor.filter(eventsFetched) : identity(eventsFetched);
	}
	shouldFetchTimestamp(event: LogEvent): boolean {
		return this.processor.shouldFetchTimestamp ? this.processor.shouldFetchTimestamp(event) : false;
	}
	shouldFetchTransaction(event: LogEvent): boolean {
		return this.processor.shouldFetchTransaction ? this.processor.shouldFetchTransaction(event) : false;
	}
}
