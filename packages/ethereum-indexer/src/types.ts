import {Abi} from 'abitype';
import {JSONObject, LogEvent, LogEventWithParsingFailure, ParsedLogEvent} from './decoding/LogEventFetcher';
import {LogFetcherConfig} from './engine/LogFetcher';

export type {LogFetcher, LogFetcherConfig} from './engine/LogFetcher';
export type {LogEvent, LogEventFetcher} from './decoding/LogEventFetcher';

// when state can be serialised and fit in memory (especialy useful in browser context), we can have it returned
export type EventProcessor<ABI extends Abi, ProcessResultType = void> = {
	load: (source: IndexingSource<ABI>) => Promise<LastSync<ABI>>;
	process: (eventStream: EventWithId<ABI>[], lastSync: LastSync<ABI>) => Promise<ProcessResultType>;
	reset: () => Promise<void>;
	filter?: (eventsFetched: LogEvent<ABI>[]) => Promise<LogEvent<ABI>[]>;
	shouldFetchTimestamp?: (event: LogEvent<ABI>) => boolean;
	shouldFetchTransaction?: (event: LogEvent<ABI>) => boolean;
};

export type EventBlock<ABI extends Abi> = {
	number: number;
	hash: string;
	events: LogEvent<ABI>[];
};

export type LastSync<ABI extends Abi> = {
	latestBlock: number;
	lastToBlock: number;
	unconfirmedBlocks: EventBlock<ABI>[];
	nextStreamID: number;
};

export type EventWithId<ABI extends Abi, Extra extends JSONObject = undefined> = LogEvent<ABI, Extra> & {
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

export type ExistingStreamFecther<ABI extends Abi> = (
	nextStreamID: number
) => Promise<{lastSync: LastSync<ABI>; eventStream: EventWithId<ABI>[]}>;
export type StreamSaver<ABI extends Abi> = (stream: {
	lastSync: LastSync<ABI>;
	eventStream: EventWithId<ABI>[];
}) => Promise<void>;

export type IndexerConfig<ABI extends Abi> = LogFetcherConfig & {
	finality?: number;
	alwaysFetchTimestamps?: boolean;
	alwaysFetchTransactions?: boolean;
	providerSupportsETHBatch?: boolean;
	fetchExistingStream?: ExistingStreamFecther<ABI>;
	saveAppendedStream?: StreamSaver<ABI>;
};
