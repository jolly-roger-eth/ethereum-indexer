import {SingleEventJSONProcessor, EventProcessorOnJSON} from './EventProcessorOnJSON';
import {EventWithId, LogEvent} from 'ethereum-indexer';
import {JSObject} from './types';

export type EventProcessorOnJSONConfig = {
	// TODO state saver and fetcher
};

export function fromSingleJSONEventProcessor<T extends JSObject>(
	v: SingleEventJSONProcessor<T> | (() => SingleEventJSONProcessor<T>)
): (config?: EventProcessorOnJSONConfig) => EventProcessorOnJSON<T> {
	return (config?: EventProcessorOnJSONConfig) => {
		// TODO pass state saver and fetcher
		return new EventProcessorOnJSON<T>(typeof v === 'function' ? v() : v);
	};
}

export type SingleJSONEventProcessorObject<T extends JSObject> = {
	[func: string]: (json: T, event: EventWithId) => void;
} & {
	setup?(json: T): Promise<void>;
	shouldFetchTimestamp?(event: LogEvent): boolean;
	shouldFetchTransaction?(event: LogEvent): boolean;
	filter?: (eventsFetched: LogEvent[]) => Promise<LogEvent[]>;
};

export class SingleJSONEventProcessorWrapper<T extends JSObject> implements SingleEventJSONProcessor<T> {
	constructor(protected obj: SingleJSONEventProcessorObject<T>) {}

	processEvent(json: T, event: EventWithId) {
		const functionName = `on${event.name}`;
		if (this.obj[functionName]) {
			return this.obj[functionName](json, event);
		}
	}
	async setup(json: T): Promise<void> {
		if (this.obj.setup) {
			return this.obj.setup(json);
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

export function fromSingleJSONEventProcessorObject<T extends JSObject>(
	v: SingleJSONEventProcessorObject<T> | (() => SingleJSONEventProcessorObject<T>)
): (config?: EventProcessorOnJSONConfig) => EventProcessorOnJSON<T> {
	return (config?: EventProcessorOnJSONConfig) => {
		// TODO pass state saver and fetcher
		return new EventProcessorOnJSON<T>(
			typeof v === 'function' ? new SingleJSONEventProcessorWrapper(v()) : new SingleJSONEventProcessorWrapper(v)
		);
	};
}

export function computeArchiveID(id: string, endBlock: number): string {
	return `archive_${endBlock}_${id}`;
}

export function computeEventID(event: EventWithId): string {
	return `${event.transactionHash}_${event.logIndex}`;
}
