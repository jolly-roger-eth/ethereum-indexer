export * from './IndexerState';

export {simple_hash} from 'ethereum-indexer';
export * from './storage/state/OnIndexedDB';
export * from './storage/state/OnLocalStorage';
export * from './storage/stream/OnIndexedDB';

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
	StreamFecther,
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
	ExistingStateFecther,
	StateSaver,
	ProcessorContext,
	ExistingStream,
} from 'ethereum-indexer';
