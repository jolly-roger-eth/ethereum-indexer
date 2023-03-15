import {EventProcessorOnJSON} from './EventProcessorOnJSON';
import {Abi, EventWithId, LogEvent, UnparsedEventWithId} from 'ethereum-indexer';
import {EventFunctions, JSObject} from './types';

export type JSProcessor<
	ABI extends Abi,
	ProcessResultType extends JSObject,
	ProcessorConfig = undefined
> = EventFunctions<ABI, ProcessResultType, ProcessorConfig> & {
	version?: string;
	construct(): ProcessResultType;
	handleUnparsedEvent?(json: ProcessResultType, event: UnparsedEventWithId);
};

class SingleJSONEventProcessorWrapper<ABI extends Abi, ProcessResultType extends JSObject, ProcessorConfig> {
	version: string | undefined;
	constructor(protected obj: JSProcessor<ABI, ProcessResultType, ProcessorConfig>) {
		this.version = obj.version;
	}

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
