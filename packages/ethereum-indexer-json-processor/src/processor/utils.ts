import {EventProcessorOnJSON} from './EventProcessorOnJSON';
import {Abi, EventWithId, LogEvent, UnparsedEventWithId} from 'ethereum-indexer';
import {EventFunctions, JSObject} from './types';

export type JSProcessor<ABI extends Abi, ProcessResultType extends JSObject, ProcessorConfig = void> = EventFunctions<
	ABI,
	ProcessResultType,
	ProcessorConfig
> & {
	construct(): ProcessResultType;
	shouldFetchTimestamp?(event: LogEvent<ABI>): boolean;
	shouldFetchTransaction?(event: LogEvent<ABI>): boolean;
	filter?: (eventsFetched: LogEvent<ABI>[]) => Promise<LogEvent<ABI>[]>;
	handleUnparsedEvent?(json: ProcessResultType, event: UnparsedEventWithId);
};

class SingleJSONEventProcessorWrapper<ABI extends Abi, ProcessResultType extends JSObject, ProcessorConfig> {
	constructor(protected obj: JSProcessor<ABI, ProcessResultType, ProcessorConfig>) {}

	createInitialState(): ProcessResultType {
		return this.obj.construct();
	}

	protected config: ProcessorConfig;
	configure(config: ProcessorConfig): void {
		this.config = config;
	}

	processEvent(json: ProcessResultType, event: EventWithId<ABI>) {
		if ('decodeError' in event) {
			if (this.obj.handleUnparsedEvent) {
				return this.obj.handleUnparsedEvent(json, event);
			}
			return;
		}
		const functionName = `on${event.eventName}`;
		if (this.obj[functionName]) {
			return this.obj[functionName](json, event, this.config);
		}
	}
	construct(): ProcessResultType {
		if (this.obj.construct) {
			return this.obj.construct();
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

export function fromJSProcessor<ABI extends Abi, ProcessResultType extends JSObject, ProcessorConfig>(
	v: (() => JSProcessor<ABI, ProcessResultType, ProcessorConfig>) | JSProcessor<ABI, ProcessResultType, ProcessorConfig>
): () => EventProcessorOnJSON<ABI, ProcessResultType, ProcessorConfig> {
	return () => {
		return new EventProcessorOnJSON<ABI, ProcessResultType, ProcessorConfig>(
			new SingleJSONEventProcessorWrapper(typeof v === 'function' ? v() : v)
		);
	};
}

export function computeArchiveID(id: string, endBlock: number): string {
	return `archive_${endBlock}_${id}`;
}

export function computeEventID<ABI extends Abi>(event: EventWithId<ABI>): string {
	return `${event.transactionHash}_${event.logIndex}`;
}
