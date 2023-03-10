import {PouchDatabase} from './PouchDatabase';
import {SingleEventProcessor, EventProcessorOnDatabase} from './EventProcessorOnDatabase';
import {QueriableEventProcessor} from './QueriableEventProcessor';
import {Database, PutAndGetDatabase} from './Database';
import {Abi, EventWithId, LogEvent, UnparsedEventWithId} from 'ethereum-indexer';
import {EventProcessorWithBatchDBUpdate, SingleEventProcessorWithBatchSupport} from './EventProcessorWithBatchDBUpdate';

export function fromSingleEventProcessor<ABI extends Abi>(
	v: SingleEventProcessor<ABI> | (() => SingleEventProcessor<ABI>)
): (config?: {folder: string}) => QueriableEventProcessor<ABI> {
	return (config?: {folder: string}) => {
		const db = new PouchDatabase(`${config?.folder || '__db__'}/data.db`);
		return new EventProcessorOnDatabase(typeof v === 'function' ? v() : v, db);
	};
}

export type SingleEventProcessorObject<ABI extends Abi> = {
	[func: string]: (db: PutAndGetDatabase, event: EventWithId<ABI>) => Promise<void>;
} & {
	setup?(db: Database): Promise<void>;
	shouldFetchTimestamp?(event: LogEvent<ABI>): boolean;
	shouldFetchTransaction?(event: LogEvent<ABI>): boolean;
	filter?: (eventsFetched: LogEvent<ABI>[]) => Promise<LogEvent<ABI>[]>;
	handleUnparsedEvent?(event: UnparsedEventWithId);
};

export class SingleEventProcessorWrapper<ABI extends Abi> implements SingleEventProcessor<ABI> {
	constructor(protected obj: SingleEventProcessorObject<ABI>) {}

	async processEvent(db: PutAndGetDatabase, event: EventWithId<ABI>): Promise<void> {
		if ('decodeError' in event) {
			if ('handleUnparsedEvent' in this.obj) {
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
	shouldFetchTimestamp?(event: LogEvent<ABI>): boolean {
		if (this.obj.shouldFetchTimestamp) {
			return this.obj.shouldFetchTimestamp(event);
		}
		return false;
	}
	shouldFetchTransaction?(event: LogEvent<ABI>): boolean {
		if (this.obj.shouldFetchTransaction) {
			return this.obj.shouldFetchTransaction(event);
		}
		return false;
	}
	async filter(eventsFetched: LogEvent<ABI>[]): Promise<LogEvent<ABI>[]> {
		if (this.obj.filter) {
			return this.obj.filter(eventsFetched);
		}
		return eventsFetched;
	}
}

export function fromSingleEventProcessorObject<ABI extends Abi>(
	v: SingleEventProcessorObject<ABI> | (() => SingleEventProcessorObject<ABI>)
): (config?: {folder: string}) => QueriableEventProcessor<ABI> {
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
): (config?: {folder: string}) => QueriableEventProcessor<ABI> {
	return (config?: {folder: string}) => {
		const db = new PouchDatabase(`${config?.folder || '__db__'}/data.db`);
		return new EventProcessorWithBatchDBUpdate(typeof v === 'function' ? v() : v, db);
	};
}

export function computeArchiveID(id: string, endBlock: number): string {
	return `archive_${endBlock}_${id}`;
}

export function computeEventID<ABI extends Abi>(event: EventWithId<ABI>): string {
	return `${event.transactionHash}_${event.logIndex}`;
}
