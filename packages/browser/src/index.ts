export * from './IndexerState.js';

export {simple_hash} from '@etherfold/core';
// where a browser deployment's ENTITY state lives (the storage seam), which is a
// different question from how a whole-state blob is kept below
export * from './storage/state-store/BrowserStateStore.js';
export * from './storage/state/OnIndexedDB.js';
export * from './storage/state/OnLocalStorage.js';
export * from './storage/stream/OnIndexedDB.js';

// convenience : export type from @etherfold/core and incidently from abitype

// TODO
// typescript 5 export type * from '@etherfold/core';
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
} from '@etherfold/core';
