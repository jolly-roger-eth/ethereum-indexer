import {Abi, LogEvent, LogEventWithParsingFailure} from 'ethereum-indexer';
import {PouchDatabase, QueriableEventProcessor, PutAndGetDatabase, Database} from 'ethereum-indexer-db-utils';
import {SingleEventProcessor, EventProcessorOnDatabase} from './EventProcessorOnDatabase';
import {EventProcessorWithBatchDBUpdate, SingleEventProcessorWithBatchSupport} from './EventProcessorWithBatchDBUpdate';

export function fromSingleEventProcessor<ABI extends Abi>(
	v: SingleEventProcessor<ABI> | (() => SingleEventProcessor<ABI>)
): (config?: {folder: string}) => QueriableEventProcessor<ABI, void> {
	return (config?: {folder: string}) => {
		const db = new PouchDatabase(`${config?.folder || '__db__'}/data.db`);
		return new EventProcessorOnDatabase(typeof v === 'function' ? v() : v, db);
	};
}

export type SingleEventProcessorObject<ABI extends Abi> = {
	[func: string]: (db: PutAndGetDatabase, event: LogEvent<ABI>) => Promise<void>;
} & {
	setup?(db: Database): Promise<void>;
	handleUnparsedEvent?(event: LogEventWithParsingFailure): void;
	getVersionHash(): string;
};

export class SingleEventProcessorWrapper<ABI extends Abi> implements SingleEventProcessor<ABI> {
	constructor(protected obj: SingleEventProcessorObject<ABI>) {}

	async processEvent(db: PutAndGetDatabase, event: LogEvent<ABI>): Promise<void> {
		if ('decodeError' in event) {
			if ('handleUnparsedEvent' in this.obj && this.obj.handleUnparsedEvent) {
				return this.obj.handleUnparsedEvent(event);
			}
		} else {
			const functionName = `on${event.eventName}`;
			if (this.obj[functionName]) {
				return this.obj[functionName](db, event);
			}
		}
	}
	async setup(db: Database): Promise<void> {
		if (this.obj.setup) {
			return this.obj.setup(db);
		}
	}

	getVersionHash(): string {
		return this.obj.getVersionHash();
	}
}

export function fromSingleEventProcessorObject<ABI extends Abi>(
	v: SingleEventProcessorObject<ABI> | (() => SingleEventProcessorObject<ABI>)
): (config?: {folder: string}) => QueriableEventProcessor<ABI, void> {
	return (config?: {folder: string}) => {
		const db = new PouchDatabase(`${config?.folder || '__db__'}/data.db`);
		return new EventProcessorOnDatabase(
			typeof v === 'function' ? new SingleEventProcessorWrapper(v()) : new SingleEventProcessorWrapper(v),
			db
		);
	};
}

export function fromSingleEventProcessorWithBatchSupportObject<ABI extends Abi>(
	v: SingleEventProcessorWithBatchSupport<ABI> | (() => SingleEventProcessorWithBatchSupport<ABI>)
): (config?: {folder: string}) => QueriableEventProcessor<ABI, void> {
	return (config?: {folder: string}) => {
		const db = new PouchDatabase(`${config?.folder || '__db__'}/data.db`);
		return new EventProcessorWithBatchDBUpdate(typeof v === 'function' ? v() : v, db);
	};
}
