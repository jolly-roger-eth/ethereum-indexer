import {Abi, EventWithId} from 'ethereum-indexer';
import {exportEvents, loadAll} from '.';
import fs from 'fs-extra';

let hashCounter = 1;
function randomHash(): string {
	return '0x4200000000000000000000000000000000000000' + (hashCounter++).toString().padStart(24, '0');
}

let addressCounter = 1;
function randomAddress(): string {
	return '0x4200000000000000' + (addressCounter++).toString().padStart(24, '0');
}

function mutateViaTmpRandomEvent<ABI extends Abi>(events: EventWithId<ABI>[], index: number): EventWithId<ABI>[] {
	const event = events[index];
	const mutated = {...event};
	mutated.blockHash = randomHash();
	mutated.transactionHash = randomHash();
	mutated.args = {...event.args};
	(mutated.args as any).to = randomAddress(); // TODO test types: this need to be typed
	events.splice(index, 1, ...[mutated, {...mutated, removed: true}, event]);
	return events;
}

function mutateViaTmpReversal<ABI extends Abi>(events: EventWithId<ABI>[], index: number): EventWithId<ABI>[] {
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

	// -------------------------------------------------------
	mutateViaTmpRandomEvent(eventStream, 0);
	mutateViaTmpReversal(eventStream, 2);
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
