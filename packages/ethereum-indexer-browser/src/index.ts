export * from './IndexerState.js';

export {simple_hash} from 'ethereum-indexer';
export * from './storage/state/OnIndexedDB.js';
export * from './storage/state/OnLocalStorage.js';
export * from './storage/stream/OnIndexedDB.js';

// convenience : export type from ethereum-indexer and incidently from abitype

// TODO
// typescript 5 export type * from 'ethereum-indexer';
export type {
	AllContractData,
	ContractData,
	IndexingSource,
	EthereumIndexer,
	EventBlock,
	EventProcessor,
	StreamFetcher,
	ProvidedIndexerConfig,
	UsedIndexerConfig,
	UsedStreamConfig,
	ProvidedStreamConfig,
	LastSync,
	LoadingState,
	LogEvent,
	LogParseConfig,
	EventProcessorWithInitialState,
	AllData,
	ExistingStateFetcher,
	StateSaver,
	ProcessorContext,
	ExistingStream,
} from 'ethereum-indexer';
