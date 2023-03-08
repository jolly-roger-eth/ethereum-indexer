import {JSONObject, JSONType, LogEvent, LogFetcherConfig} from './engine/ethereum';

export type {LogEvent, LogEventFetcher, LogFetcher, LogFetcherConfig} from './engine/ethereum';

// when state can be serialised and fit in memory (especialy useful in browser context), we can have it returned
export type EventProcessor<T = void> = {
	state?: T;
	load: (source: IndexingSource) => Promise<LastSync>;
	process: (eventStream: EventWithId[], lastSync: LastSync) => Promise<T>;
	reset: () => Promise<void>;
	filter?: (eventsFetched: LogEvent[]) => Promise<LogEvent[]>;
	shouldFetchTimestamp?: (event: LogEvent) => boolean;
	shouldFetchTransaction?: (event: LogEvent) => boolean;
};

export type EventBlock = {
	number: number;
	hash: string;
	events: LogEvent[];
};

export type LastSync = {
	latestBlock: number;
	lastToBlock: number;
	unconfirmedBlocks: EventBlock[];
	nextStreamID: number;
};

export type EventWithId<
	Args extends {
		[key: string]: JSONType;
	} = {
		[key: string]: JSONType;
	},
	Extra extends JSONObject = JSONObject
> = LogEvent<Args, Extra> & {
	streamID: number;
};

export type BlockEvents = {hash: string; number: number; events: LogEvent[]};

export type GenericABI = readonly any[];
export type ContractData = {
	readonly abi: GenericABI;
	readonly address: string;
	readonly startBlock?: number;
	readonly history?: readonly {readonly abi: GenericABI; readonly startBlock?: number}[];
};

export type AllContractData = {
	readonly abi: GenericABI;
	readonly startBlock?: number;
};

export type IndexingSource = {readonly contracts: readonly ContractData[] | AllContractData; readonly chainId: string};

export type ExistingStreamFecther = (nextStreamID: number) => Promise<{lastSync: LastSync; eventStream: EventWithId[]}>;
export type StreamSaver = (stream: {lastSync: LastSync; eventStream: EventWithId[]}) => Promise<void>;

export type IndexerConfig = LogFetcherConfig & {
	finality?: number;
	alwaysFetchTimestamps?: boolean;
	alwaysFetchTransactions?: boolean;
	providerSupportsETHBatch?: boolean;
	fetchExistingStream?: ExistingStreamFecther;
	saveAppendedStream?: StreamSaver;
};
