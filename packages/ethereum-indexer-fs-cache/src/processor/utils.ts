import path from 'path';
import fs from 'fs-extra';
import {Abi, LogEvent, LastSync} from 'ethereum-indexer';

export function loadAll<ABI extends Abi>(folder: string): LogEvent<ABI>[] {
	const wholeEventStream: LogEvent<ABI>[] = [];
	folder = path.join(folder, 'logs');
	const files = fs.readdirSync(folder);
	const eventFiles = files.filter((v: string) => v.startsWith('events_'));
	if (eventFiles.length > 0) {
		for (const file of eventFiles) {
			const eventStream: LogEvent<ABI>[] = JSON.parse(fs.readFileSync(`${folder}/${file}`).toString());
			wholeEventStream.push(...eventStream);
		}
	}
	return wholeEventStream;
}

export function exportEvents<ABI extends Abi>(
	folder: string,
	eventStream: LogEvent<ABI>[],
	config?: {batchSize?: number; overrideLastSync?: boolean}
) {
	folder = path.join(folder, 'logs');
	config = Object.assign(
		{
			batchSize: 9000,
			overrideLastSync: false,
		},
		config || {}
	);

	const maxBatchSize = config.batchSize;

	const lastSyncPath = path.join(folder, 'lastSync.json');
	const lastSyncContent = fs.readFileSync(lastSyncPath, 'utf-8');
	fs.emptyDirSync(folder);
	fs.writeFileSync(lastSyncPath, lastSyncContent);
	// TODO
	// for (let i = 0; i < eventStream.length; i += maxBatchSize) {
	// 	const subStream: LogEvent<ABI>[] = eventStream.slice(i, Math.min(i + maxBatchSize, eventStream.length));
	// 	let eventID = i + 1; // recompute ids
	// 	for (const event of subStream) {
	// 		event.streamID = eventID;
	// 		eventID++;
	// 	}
	// 	const filename = `events_${lexicographicNumber15(subStream[0].streamID)}_${lexicographicNumber15(
	// 		subStream[subStream.length - 1].streamID
	// 	)}.json`;

	// 	fs.writeFileSync(folder + `/${filename}`, JSON.stringify(subStream, null, 2));
	// }
	if (config.overrideLastSync) {
		const parsed: LastSync<ABI> = JSON.parse(lastSyncContent);
		parsed.lastToBlock = eventStream[eventStream.length - 1].blockNumber;
		fs.writeFileSync(lastSyncPath, JSON.stringify(parsed, null, 2));
	}
}

export function lexicographicNumber15(num: number): string {
	return num.toString().padStart(15, '0');
}
