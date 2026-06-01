import {Abi, ParsedLogEvent} from 'ethereum-indexer';
import {exportEvents, loadAll} from './index.js';
import fs from 'fs-extra';

let hashCounter = 1;
function randomHash(): `0x${string}` {
	return ('0x4200000000000000000000000000000000000000' + (hashCounter++).toString().padStart(24, '0')) as `0x${string}`;
}

let addressCounter = 1;
function randomAddress(): `0x${string}` {
	return ('0x4200000000000000' + (addressCounter++).toString().padStart(24, '0')) as `0x${string}`;
}

function mutateViaTmpRandomEvent<ABI extends Abi>(events: ParsedLogEvent<ABI>[], index: number): ParsedLogEvent<ABI>[] {
	const event = events[index];
	const mutated = {...event};
	mutated.blockHash = randomHash();
	mutated.transactionHash = randomHash();
	mutated.args = {...(event.args as Record<string, unknown>)} as typeof event.args;
	(mutated.args as any).to = randomAddress(); // TODO test types: this need to be typed
	events.splice(index, 1, ...[mutated, {...mutated, removed: true}, event]);
	return events;
}

function mutateViaTmpReversal<ABI extends Abi>(events: ParsedLogEvent<ABI>[], index: number): ParsedLogEvent<ABI>[] {
	const event = events[index];
	const sameInANewBlock = {...event};
	sameInANewBlock.blockHash = randomHash();
	events.splice(index, 1, ...[event, {...event, removed: true}, sameInANewBlock]);
	return events;
}

function main() {
	const args = process.argv.slice(2);
	const srcFolder = args[0];
	let destFolder = srcFolder + '-mutated';
	if (srcFolder.endsWith('-saved')) {
		destFolder = srcFolder.slice(0, srcFolder.length - 6);
	}
	const numEventsStr = args[1];
	const startStr = args[2];
	let eventStream = loadAll(srcFolder);

	// TODO fix type, had to use any here
	// -------------------------------------------------------
	mutateViaTmpRandomEvent(eventStream as any, 0);
	mutateViaTmpReversal(eventStream as any, 2);
	// ------------------------------------------------------

	if (numEventsStr) {
		const numEvents = parseInt(numEventsStr);
		let start = 0;
		if (startStr) {
			start = parseInt(startStr);
		}
		eventStream = eventStream.slice(start, start + numEvents);
	}
	fs.emptyDirSync(destFolder + '/logs');
	fs.copySync(`${srcFolder}/logs/lastSync.json`, `${destFolder}/logs/lastSync.json`);
	exportEvents(destFolder, eventStream, {batchSize: 9000, overrideLastSync: !!numEventsStr});
}

main();
