import {Abi} from 'abitype';
import {JSONObject, LogEvent, LogEventWithParsingFailure, ParsedLogEvent} from './decoding/LogEventFetcher';
import {LogFetcherConfig} from './engine/LogFetcher';

export type {LogFetcher, LogFetcherConfig} from './engine/LogFetcher';
export type {LogEvent, LogEventFetcher} from './decoding/LogEventFetcher';

export type EventProcessor<ABI extends Abi, ProcessResultType = void> = {
	getVersionHash(): string;
	load: (source: IndexingSource<ABI>) => Promise<{state: ProcessResultType; lastSync: LastSync<ABI>} | undefined>;
	process: (eventStream: EventWithId<ABI>[], lastSync: LastSync<ABI>) => Promise<ProcessResultType>;
	reset: () => Promise<void>;
};

export type EventProcessorWithInitialState<ABI extends Abi, ProcessResultType, ProcessorConfig> = EventProcessor<
	ABI,
	ProcessResultType
> & {
	createInitialState(): ProcessResultType;
	configure(config: ProcessorConfig): void;
};

export type EventBlock<ABI extends Abi> = {
	number: number;
	hash: string;
	events: EventWithId<ABI>[]; //this could be replacec by start: number;end: number but we would need access to the old coreresponding events
};

export type ContextIdentifier = {source: {startBlock: number; hash: string}[]; config: string; processor: string};
export type LastSync<ABI extends Abi> = {
	context: ContextIdentifier;
	latestBlock: number;
	lastToBlock: number;
	unconfirmedBlocks: EventBlock<ABI>[];
	nextStreamID: number;
};

export type EventWithId<ABI extends Abi, Extra extends JSONObject = undefined> =
	| ValidEventWithId<ABI, Extra>
	| CancelledEventWithId<ABI, Extra>;

export type ValidEventWithId<ABI extends Abi, Extra extends JSONObject = undefined> = LogEvent<ABI, Extra> & {
	streamID: number;
};

export type CancelledEventWithId<ABI extends Abi, Extra extends JSONObject = undefined> = LogEvent<ABI, Extra> & {
	cancelled: true;
	streamID: number;
};

export type ParsedEventWithId<ABI extends Abi, Extra extends JSONObject = undefined> = ParsedLogEvent<ABI, Extra> & {
	streamID: number;
};

export type UnparsedEventWithId<Extra extends JSONObject = undefined> = LogEventWithParsingFailure<Extra> & {
	streamID: number;
};

export type BlockEvents<ABI extends Abi> = {hash: string; number: number; events: LogEvent<ABI>[]};

export type ContractData<ABI extends Abi> = {
	readonly abi: ABI;
	readonly address: `0x${string}`;
	readonly startBlock?: number;
	readonly history?: readonly {readonly abi: ABI; readonly startBlock?: number}[];
};

export type AllContractData<ABI extends Abi> = {
	readonly abi: ABI;
	readonly startBlock?: number;
};

export type IndexingSource<ABI extends Abi> = {
	readonly contracts: readonly ContractData<ABI>[] | AllContractData<ABI>;
	readonly chainId: string;
};

export type StreamFecther<ABI extends Abi> = (
	source: IndexingSource<ABI>,
	nextStreamID: number
) => Promise<{lastSync: LastSync<ABI>; eventStream: EventWithId<ABI>[]}>;
export type StreamSaver<ABI extends Abi> = (
	source: IndexingSource<ABI>,
	stream: {
		lastSync: LastSync<ABI>;
		eventStream: EventWithId<ABI>[];
	}
) => Promise<void>;
export type StreamClearer<ABI extends Abi> = (source: IndexingSource<ABI>) => Promise<void>;

export type IndexerConfig<ABI extends Abi> = {
	// if this changes do not need a resync
	fetch?: Omit<LogFetcherConfig, 'filters'>;

	// any change to this stream config should trigger a resync from 0
	stream?: {
		finality?: number;
		alwaysFetchTimestamps?: boolean;
		alwaysFetchTransactions?: boolean;
		parse?: LogParseConfig;
	};

	// if this changes do not need a resync
	providerSupportsETHBatch?: boolean;

	// if this changes do not need a resync
	keepStream?: ExistingStream<ABI>;
};

export type ExistingStream<ABI extends Abi> = {
	fetchFrom: StreamFecther<ABI>;
	saveNewEvents: StreamSaver<ABI>;
	clear: StreamClearer<ABI>;
};

export type LogParseConfig = {
	globalABI?: boolean;
	filters?: {
		// for each event name we can specify a list of filter
		// each filter is an array of (topic or topic[])
		// so this is an array of array of (topic | topic[])
		[eventName: string]: (`0x${string}` | `0x${string}`[])[][];
		// Note we do not provide type arg here (could have done it via abitype) because multiple event could share the same order
	};
};

export type ProcessorContext<ABI extends Abi, ProcessorConfig> = ProcessorConfig extends undefined
	? {
			readonly source: IndexingSource<ABI>;
			version?: string;
	  }
	: {
			readonly source: IndexingSource<ABI>;
			readonly config: ProcessorConfig;
			version?: string;
	  };

export type AllData<ABI extends Abi, ProcessResultType, Extra> = {
	data: ProcessResultType;
	lastSync: LastSync<ABI>;
} & Extra;

export type ExistingStateFecther<ABI extends Abi, ProcessResultType, Extra, ProcessorConfig> = (
	context: ProcessorContext<ABI, ProcessorConfig>
) => Promise<AllData<ABI, ProcessResultType, Extra>>;
export type StateSaver<ABI extends Abi, ProcessResultType, Extra, ProcessorConfig> = (
	context: ProcessorContext<ABI, ProcessorConfig>,
	all: AllData<ABI, ProcessResultType, Extra>
) => Promise<void>;
