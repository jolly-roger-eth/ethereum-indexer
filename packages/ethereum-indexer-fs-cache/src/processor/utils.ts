import path from 'path';
import fs from 'fs-extra';
import {EventWithId, LastSync} from 'ethereum-indexer';

export function loadAll(folder: string): EventWithId[] {
	const wholeEventStream: EventWithId[] = [];
	folder = path.join(folder, 'logs');
	const files = fs.readdirSync(folder);
	const eventFiles = files.filter((v: string) => v.startsWith('events_'));
	if (eventFiles.length > 0) {
		for (const file of eventFiles) {
			const eventStream: EventWithId[] = JSON.parse(fs.readFileSync(`${folder}/${file}`).toString());
			wholeEventStream.push(...eventStream);
		}
	}
	return wholeEventStream;
}

export function exportEvents(
	folder: string,
	eventStream: EventWithId[],
	config?: {batchSize?: number; overrideLastSync?: boolean}
) {
	folder = path.join(folder, 'logs');
	config = Object.assign(
		{
			batchSize: 9000,
			overrideLastSync: false
		},
		config || {}
	);

	const maxBatchSize = config.batchSize;

	const lastSyncPath = path.join(folder, 'lastSync.json');
	const lastSyncContent = fs.readFileSync(lastSyncPath, 'utf-8');
	fs.emptyDirSync(folder);
	fs.writeFileSync(lastSyncPath, lastSyncContent);
	for (let i = 0; i < eventStream.length; i += maxBatchSize) {
		const subStream: EventWithId[] = eventStream.slice(i, Math.min(i + maxBatchSize, eventStream.length));
		let eventID = i + 1; // recompute ids
		for (const event of subStream) {
			event.streamID = eventID;
			eventID++;
		}
		const filename = `events_${lexicographicNumber15(subStream[0].streamID)}_${lexicographicNumber15(
			subStream[subStream.length - 1].streamID
		)}.json`;

		fs.writeFileSync(folder + `/${filename}`, JSON.stringify(subStream, null, 2));
	}
	if (config.overrideLastSync) {
		const parsed: LastSync = JSON.parse(lastSyncContent);
		parsed.nextStreamID = eventStream[eventStream.length - 1].streamID + 1;
		parsed.lastToBlock = eventStream[eventStream.length - 1].blockNumber;
		fs.writeFileSync(lastSyncPath, JSON.stringify(parsed, null, 2));
	}
}

export function lexicographicNumber15(num: number): string {
	return num.toString().padStart(15, '0');
}
