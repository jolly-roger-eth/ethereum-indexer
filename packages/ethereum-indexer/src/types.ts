import {Abi} from 'abitype';
import {EIP1193DATA, EIP1193Log, EIP1193QUANTITY} from 'eip-1193';
import {LogEvent} from './decoding/LogEventFetcher';
import {LogFetcherConfig} from './engine/LogFetcher';

export type {LogFetcher, LogFetcherConfig} from './engine/LogFetcher';
export type {LogEvent, LogEventFetcher} from './decoding/LogEventFetcher';

export type EventProcessor<ABI extends Abi, ProcessResultType = void> = {
	getVersionHash(): string;
	load: (source: IndexingSource<ABI>) => Promise<{state: ProcessResultType; lastSync: LastSync<ABI>} | undefined>;
	process: (eventStream: LogEvent<ABI>[], lastSync: LastSync<ABI>) => Promise<ProcessResultType>;
	reset: () => Promise<void>;
	clear: () => Promise<void>;
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
	events: LogEvent<ABI>[]; //this could be replacec by start: number;end: number but we would need access to the old coreresponding events
};

export type IncludedEIP1193Log = EIP1193Log & {
	blockNumber: EIP1193DATA;
	logIndex: EIP1193DATA;
	blockHash: EIP1193DATA;
	transactionIndex: EIP1193QUANTITY;
	transactionHash: EIP1193DATA;
};

export type ContextIdentifier = {source: {startBlock: number; hash: string}[]; config: string; processor: string};
export type LastSync<ABI extends Abi> = {
	context: ContextIdentifier;
	latestBlock: number;
	lastToBlock: number;
	unconfirmedBlocks: EventBlock<ABI>[];
};

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
	fromBlock: number
) => Promise<{lastSync: LastSync<ABI>; eventStream: LogEvent<ABI>[]}>;
export type StreamSaver<ABI extends Abi> = (
	source: IndexingSource<ABI>,
	stream: {
		lastSync: LastSync<ABI>;
		eventStream: LogEvent<ABI>[];
	}
) => Promise<void>;
export type StreamClearer<ABI extends Abi> = (source: IndexingSource<ABI>) => Promise<void>;

export type StreamConfig = {
	finality?: number;
	alwaysFetchTimestamps?: boolean;
	alwaysFetchTransactions?: boolean;
	parse?: LogParseConfig;
};

export type IndexerConfig<ABI extends Abi> = {
	// if this changes do not need a resync
	fetch?: Omit<LogFetcherConfig, 'filters'>;

	// any change to this stream config should trigger a resync from 0
	stream?: StreamConfig;

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

export type KeepState<ABI extends Abi, ProcessResultType, Extra, ProcessorConfig> = {
	fetch: ExistingStateFecther<ABI, ProcessResultType, Extra, ProcessorConfig>;
	save: StateSaver<ABI, ProcessResultType, Extra, ProcessorConfig>;
	clear: (context: ProcessorContext<ABI, ProcessorConfig>) => Promise<void>;
};
