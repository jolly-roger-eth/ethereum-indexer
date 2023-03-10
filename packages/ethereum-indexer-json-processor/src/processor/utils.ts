import {SingleEventJSONProcessor, EventProcessorOnJSON} from './EventProcessorOnJSON';
import {Abi, EventWithId, LogEvent, UnparsedEventWithId} from 'ethereum-indexer';
import {EventFunctions, JSObject, MergedAbis} from './types';

export type EventProcessorOnJSONConfig = {
	// TODO state saver and fetcher
};

export function fromSingleJSONEventProcessor<ABI extends Abi, ProcessResultType extends JSObject>(
	v: SingleEventJSONProcessor<ABI, ProcessResultType> | (() => SingleEventJSONProcessor<ABI, ProcessResultType>)
): (config?: EventProcessorOnJSONConfig) => EventProcessorOnJSON<ABI, ProcessResultType> {
	return (config?: EventProcessorOnJSONConfig) => {
		// TODO pass state saver and fetcher
		return new EventProcessorOnJSON<ABI, ProcessResultType>(typeof v === 'function' ? v() : v);
	};
}

export type SingleJSONEventProcessorObject<ABI extends Abi, ProcessResultType extends JSObject> = EventFunctions<
	ABI,
	ProcessResultType
> & {
	setup?(json: ProcessResultType): Promise<void>;
	shouldFetchTimestamp?(event: LogEvent<ABI>): boolean;
	shouldFetchTransaction?(event: LogEvent<ABI>): boolean;
	filter?: (eventsFetched: LogEvent<ABI>[]) => Promise<LogEvent<ABI>[]>;
	handleUnparsedEvent?(json: ProcessResultType, event: UnparsedEventWithId);
};

class SingleJSONEventProcessorWrapper<ABI extends Abi, ProcessResultType extends JSObject> {
	constructor(protected obj: SingleJSONEventProcessorObject<ABI, ProcessResultType>) {}

	processEvent(json: ProcessResultType, event: EventWithId<ABI>) {
		if ('decodeError' in event) {
			if (this.obj.handleUnparsedEvent) {
				return this.obj.handleUnparsedEvent(json, event);
			}
			return;
		}
		const functionName = `on${event.eventName}`;
		if (this.obj[functionName]) {
			return this.obj[functionName](json, event);
		}
	}
	async setup(json: ProcessResultType): Promise<void> {
		if (this.obj.setup) {
			return this.obj.setup(json);
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
			return this.obj.filter(eventsFetched) as unknown as LogEvent<ABI>[]; // TODO why unknow casting needed here ?
		}
		return eventsFetched;
	}
}

export function fromSingleJSONEventProcessorObject<ABI extends Abi, ProcessResultType extends JSObject>(
	v:
		| SingleJSONEventProcessorObject<ABI, ProcessResultType>
		| (() => SingleJSONEventProcessorObject<ABI, ProcessResultType>)
): (config?: EventProcessorOnJSONConfig) => EventProcessorOnJSON<ABI, ProcessResultType> {
	return (config?: EventProcessorOnJSONConfig) => {
		// TODO pass state saver and fetcher
		return new EventProcessorOnJSON<ABI, ProcessResultType>(
			typeof v === 'function' ? new SingleJSONEventProcessorWrapper(v()) : new SingleJSONEventProcessorWrapper(v)
		);
	};
}

export function computeArchiveID(id: string, endBlock: number): string {
	return `archive_${endBlock}_${id}`;
}

export function computeEventID<ABI extends Abi>(event: EventWithId<ABI>): string {
	return `${event.transactionHash}_${event.logIndex}`;
}
