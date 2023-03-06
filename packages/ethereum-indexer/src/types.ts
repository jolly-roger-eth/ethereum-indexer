import {JSONObject, JSONType, LogEvent, LogFetcherConfig} from './engine/ethereum';

export type {LogEvent, LogEventFetcher, LogFetcher, LogFetcherConfig} from './engine/ethereum';

export type EventProcessor = {
	load: (contractsData: ContractsInfo) => Promise<LastSync>;
	process: (eventStream: EventWithId[], lastSync: LastSync) => Promise<void>;
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

export type ContractData = {
	eventsABI: any[];
	address: string;
	startBlock?: number;
};

export type AllContractData = {eventsABI: any[]; startBlock?: number};

export type ContractsInfo = ContractData[] | AllContractData;

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
