import {JSObjectEventProcessor} from './JSObjectEventProcessor';
import {Abi, ExtractAbiEvent, LogEvent, LogEventWithParsingFailure} from 'ethereum-indexer';
import {EventFunctions, InputValues, JSObject} from './types';

export type EventWithArgs<ABI extends Abi, Property extends string> = LogEvent<ABI> & {
	args: InputValues<ExtractAbiEvent<ABI, Property>>;
};

export type JSProcessor<
	ABI extends Abi,
	ProcessResultType extends JSObject,
	ProcessorConfig = undefined
> = EventFunctions<ABI, ProcessResultType, ProcessorConfig> & {
	version?: string;
	construct(): ProcessResultType;
	handleUnparsedEvent?(json: ProcessResultType, event: LogEventWithParsingFailure): void | Promise<void>;
};

class SingleJSONEventProcessorWrapper<ABI extends Abi, ProcessResultType extends JSObject, ProcessorConfig> {
	version: string | undefined;
	constructor(protected obj: JSProcessor<ABI, ProcessResultType, ProcessorConfig>) {
		this.version = obj.version;
	}

	createInitialState(): ProcessResultType {
		return this.obj.construct();
	}

	protected config: ProcessorConfig | undefined;
	configure(config: ProcessorConfig): void {
		this.config = config;
	}

	processEvent(json: ProcessResultType, event: LogEvent<ABI>): Promise<void> | void {
		if ('decodeError' in event) {
			if (this.obj.handleUnparsedEvent) {
				return this.obj.handleUnparsedEvent(json, event);
			}
			return;
		}
		const functionName = `on${event.eventName}`;
		if ((this.obj as any)[functionName]) {
			return (this.obj as any)[functionName](json, event, this.config);
		}
	}
	construct(): ProcessResultType {
		if (this.obj.construct) {
			return this.obj.construct();
		}
		return undefined as any;
	}
}

export function fromJSProcessor<ABI extends Abi, ProcessResultType extends JSObject, ProcessorConfig>(
	v: (() => JSProcessor<ABI, ProcessResultType, ProcessorConfig>) | JSProcessor<ABI, ProcessResultType, ProcessorConfig>
): () => JSObjectEventProcessor<ABI, ProcessResultType, ProcessorConfig> {
	return () => {
		return new JSObjectEventProcessor<ABI, ProcessResultType, ProcessorConfig>(
			new SingleJSONEventProcessorWrapper(typeof v === 'function' ? v() : v)
		);
	};
}

// export function computeArchiveID(id: string, endBlock: number): string {
// 	return `archive_${endBlock}_${id}`;
// }

// export function computeEventID<ABI extends Abi>(event: LogEvent<ABI>): string {
// 	return `${event.transactionHash}_${event.logIndex}`;
// }
