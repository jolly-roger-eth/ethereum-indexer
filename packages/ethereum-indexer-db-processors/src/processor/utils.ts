import {PouchDatabase} from './PouchDatabase';
import {SingleEventProcessor, EventProcessorOnDatabase} from './EventProcessorOnDatabase';
import {QueriableEventProcessor} from './QueriableEventProcessor';
import {Database, PutAndGetDatabase} from './Database';
import {EventWithId, LogEvent} from 'ethereum-indexer';
import {EventProcessorWithBatchDBUpdate, SingleEventProcessorWithBatchSupport} from './EventProcessorWithBatchDBUpdate';

export function fromSingleEventProcessor(
	v: SingleEventProcessor | (() => SingleEventProcessor)
): (folder: string) => QueriableEventProcessor {
	return (folder: string) => {
		const db = new PouchDatabase(`${folder}/data.db`);
		return new EventProcessorOnDatabase(typeof v === 'function' ? v() : v, db);
	};
}

export type SingleEventProcessorObject = {
	[func: string]: (db: PutAndGetDatabase, event: EventWithId) => Promise<void>;
} & {
	setup?(db: Database): Promise<void>;
	shouldFetchTimestamp?(event: LogEvent): boolean;
	shouldFetchTransaction?(event: LogEvent): boolean;
	filter?: (eventsFetched: LogEvent[]) => Promise<LogEvent[]>;
};

export class SingleEventProcessorWrapper implements SingleEventProcessor {
	constructor(protected obj: SingleEventProcessorObject) {}

	async processEvent(db: PutAndGetDatabase, event: EventWithId): Promise<void> {
		const functionName = `on${event.name}`;
		if (this.obj[functionName]) {
			return this.obj[functionName](db, event);
		}
	}
	async setup(db: Database): Promise<void> {
		if (this.obj.setup) {
			return this.obj.setup(db);
		}
	}
	shouldFetchTimestamp?(event: LogEvent): boolean {
		if (this.obj.shouldFetchTimestamp) {
			return this.obj.shouldFetchTimestamp(event);
		}
		return false;
	}
	shouldFetchTransaction?(event: LogEvent): boolean {
		if (this.obj.shouldFetchTransaction) {
			return this.obj.shouldFetchTransaction(event);
		}
		return false;
	}
	async filter(eventsFetched: LogEvent[]): Promise<LogEvent[]> {
		if (this.obj.filter) {
			return this.obj.filter(eventsFetched);
		}
		return eventsFetched;
	}
}

export function fromSingleEventProcessorObject(
	v: SingleEventProcessorObject | (() => SingleEventProcessorObject)
): (folder: string) => QueriableEventProcessor {
	return (folder: string) => {
		const db = new PouchDatabase(`${folder}/data.db`);
		return new EventProcessorOnDatabase(
			typeof v === 'function' ? new SingleEventProcessorWrapper(v()) : new SingleEventProcessorWrapper(v),
			db
		);
	};
}

export function fromSingleEventProcessorWithBatchSupportObject(
	v: SingleEventProcessorWithBatchSupport | (() => SingleEventProcessorWithBatchSupport)
): (folder: string) => QueriableEventProcessor {
	return (folder: string) => {
		const db = new PouchDatabase(`${folder}/data.db`);
		return new EventProcessorWithBatchDBUpdate(typeof v === 'function' ? v() : v, db);
	};
}

export function computeArchiveID(id: string, endBlock: number): string {
	return `archive_${endBlock}_${id}`;
}

export function computeEventID(event: EventWithId): string {
	return `${event.transactionHash}_${event.logIndex}`;
}
