import {JSObjectEventProcessor} from './JSObjectEventProcessor.js';
import {
	Abi,
	assertProcessorVersion,
	ExtractAbiEvent,
	LogEvent,
	LogEventWithParsingFailure,
	processorCodeFingerprint,
} from 'ethereum-indexer';
import {EventFunctions, InputValues, JSObject} from './types.js';

export type EventWithArgs<ABI extends Abi, Property extends string> = LogEvent<ABI> & {
	args: InputValues<ExtractAbiEvent<ABI, Property>>;
};

export type JSProcessor<
	ABI extends Abi,
	ProcessResultType extends JSObject,
	ProcessorConfig = undefined,
> = EventFunctions<ABI, ProcessResultType, ProcessorConfig> & {
	/**
	 * REQUIRED. The identity of this processor's logic.
	 *
	 * The indexer discards state computed by a previous version by comparing
	 * this, so a processor with no version can never invalidate anything: every
	 * edit to a handler would keep serving state computed by the code you
	 * replaced. Ideally generate it (from a content hash, a build id, a git sha)
	 * so it cannot be forgotten; if you edit it by hand, bump it whenever a
	 * handler changes, and watch for the drift report when you forget.
	 */
	version: string;
	construct(): ProcessResultType;
	handleUnparsedEvent?(json: ProcessResultType, event: LogEventWithParsingFailure): void | Promise<void>;
};

class SingleJSONEventProcessorWrapper<ABI extends Abi, ProcessResultType extends JSObject, ProcessorConfig> {
	version: string;
	constructor(protected obj: JSProcessor<ABI, ProcessResultType, ProcessorConfig>) {
		// Asserted HERE as well as in `JSObjectEventProcessor`, because this is the
		// last place the author's own object is visible: the message can name the
		// processor by its handlers, which is the only name a plain object has.
		assertProcessorVersion(obj, 'JSObjectEventProcessor');
		this.version = obj.version;
	}

	/**
	 * The advisory fingerprint of the AUTHOR's handlers, not of this wrapper.
	 *
	 * Fingerprinting the wrapper would be worse than useless: its methods are the
	 * same four functions for every processor ever written, so it would hash to a
	 * constant and no edit could ever move it.
	 */
	getCodeFingerprint(): string | undefined {
		return processorCodeFingerprint(this.obj);
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
	v:
		| (() => JSProcessor<ABI, ProcessResultType, ProcessorConfig>)
		| JSProcessor<ABI, ProcessResultType, ProcessorConfig>,
): () => JSObjectEventProcessor<ABI, ProcessResultType, ProcessorConfig> {
	return () => {
		return new JSObjectEventProcessor<ABI, ProcessResultType, ProcessorConfig>(
			new SingleJSONEventProcessorWrapper(typeof v === 'function' ? v() : v),
		);
	};
}

// export function computeArchiveID(id: string, endBlock: number): string {
// 	return `archive_${endBlock}_${id}`;
// }

// export function computeEventID<ABI extends Abi>(event: LogEvent<ABI>): string {
// 	return `${event.transactionHash}_${event.logIndex}`;
// }
