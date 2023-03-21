import {IndexingSource, EventProcessor, LastSync, LogEvent, Abi, UsedStreamConfig} from 'ethereum-indexer';
import fs from 'fs';
import path from 'path';
import {logs} from 'named-logs';
import {lexicographicNumber15} from './utils';
const namedLogger = logs('EventListFSStore');

function identity(arg: any): any {
	return arg;
}

export class ProcessorFilesystemCache<ABI extends Abi, ProcessResultType>
	implements EventProcessor<ABI, ProcessResultType>
{
	protected folder: string;
	constructor(protected processor: EventProcessor<ABI, ProcessResultType>, folder: string) {
		this.folder = path.join(folder, 'logs');
		try {
			fs.mkdirSync(this.folder, {recursive: true});
		} catch (err) {}
	}

	getVersionHash(): string {
		return this.processor.getVersionHash();
	}

	async reset() {
		try {
			await this.processor.reset();
		} catch (err) {
			namedLogger.error(`failed to reset : ${err}`);
		}
	}

	async clear() {
		try {
			await this.processor.reset();
			fs.rmSync(this.folder, {recursive: true});
			fs.mkdirSync(this.folder, {recursive: true});
		} catch (err) {
			namedLogger.error(`failed to reset : ${err}`);
		}
	}

	async load(
		source: IndexingSource<ABI>,
		streamConfig: UsedStreamConfig
	): Promise<{lastSync: LastSync<ABI>; state: ProcessResultType} | undefined> {
		let lastSync: LastSync<ABI> | undefined;
		try {
			const content = fs.readFileSync(this.folder + `/lastSync.json`, 'utf8');
			lastSync = JSON.parse(content);
		} catch (err) {
			console.error(`ERROR while getting the lastSync.json`);
			return undefined;
		}

		if (!lastSync) {
			return undefined;
		}

		// TODO check if source matches old sync
		const fromProcessor = await this.processor.load(source, streamConfig);
		if (!fromProcessor) {
			return undefined;
		}
		let lastOutcome: ProcessResultType = fromProcessor.state;
		let lastSyncFromProcessor = fromProcessor.lastSync;

		const files = fs.readdirSync(this.folder);
		namedLogger.info(`loading ${files} files of events...`);
		const eventFiles = files.filter((v: string) => v.startsWith('events_'));
		if (eventFiles.length > 0) {
			for (const file of eventFiles) {
				const eventStream: LogEvent<ABI>[] = JSON.parse(fs.readFileSync(`${this.folder}/${file}`).toString());
				const maxBatchSize = 128;

				const [_, fromBlockAsString, toBlockAsString] = file.split('_');
				const fromBlock = parseInt(fromBlockAsString);
				const toBlock = parseInt(toBlockAsString);

				let lastSubStream: LogEvent<ABI>[] | undefined;
				if (eventStream.length > maxBatchSize) {
					namedLogger.info(`eventStream size bigger than ${maxBatchSize} : ${eventStream.length}`);
					for (let i = 0; i < eventStream.length; i += maxBatchSize) {
						const subStream: LogEvent<ABI>[] = eventStream.slice(i, i + maxBatchSize);

						namedLogger.info(`sending ${subStream.length} (from ${i} to ${i + maxBatchSize - 1})`);

						// TODO group per block and use the correspondong lastToBlock,
						lastSyncFromProcessor = {
							context: lastSync.context,
							lastToBlock: i === eventStream.length - 1 ? toBlock : subStream[subStream.length - 1].blockNumber,
							latestBlock: lastSync.latestBlock,
							lastFromBlock: !lastSubStream ? fromBlock : lastSubStream[subStream.length - 1].blockNumber,
							unconfirmedBlocks: [], // TODO ?
						};
						lastSubStream = subStream;
						namedLogger.info('processing substream...');
						await this.processor.process(subStream, lastSyncFromProcessor);
					}
				} else {
					lastSyncFromProcessor = {
						context: lastSync.context,
						lastToBlock: toBlock,
						latestBlock: lastSync.latestBlock,
						lastFromBlock: fromBlock,
						unconfirmedBlocks: [], // TODO ?
					};
					namedLogger.info('processing stream...');
					lastOutcome = await this.processor.process(eventStream, lastSyncFromProcessor);
				}
			}
		}

		return {lastSync, state: lastOutcome};
	}

	async process(eventStream: LogEvent<ABI>[], lastSync: LastSync<ABI>): Promise<ProcessResultType> {
		const outcome = await this.processor.process(eventStream, lastSync);
		if (eventStream.length > 0) {
			// TODO
			// use lastSync to get an equivalent stream ID ?
			// const filename = `events_${lexicographicNumber15(eventStream[0].streamID)}_${lexicographicNumber15(
			// 	eventStream[eventStream.length - 1].streamID
			// )}.json`;
			// fs.writeFileSync(this.folder + `/${filename}`, JSON.stringify(eventStream, null, 2));
		}
		fs.writeFileSync(this.folder + `/lastSync.json`, JSON.stringify(lastSync));
		return outcome;
	}
}
