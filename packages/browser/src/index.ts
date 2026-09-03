export * from './IndexerState.js';

export {simple_hash} from '@etherfold/core';
// where a browser deployment's state lives (the storage seam)
export * from './storage/state-store/BrowserStateStore.js';
export * from './storage/keyval.js';
export * from './storage/stream/OnIndexedDB.js';
// which generations this indexer holds, and which one answers reads
export * from './storage/generation/OnIndexedDB.js';

// convenience : export type from @etherfold/core and incidently from abitype

// TODO
// typescript 5 export type * from '@etherfold/core';
export type {
	AllContractData,
	ContractData,
	IndexingSource,
	// ONE generation: one stream, one processor, one state. An indexer HOLDS these
	// and points at the one that answers reads; `createIndexerState` opens that
	// container, so this type is here for a caller that names the engine (a
	// `createIndexer` factory, a spy) rather than one that builds an indexer.
	IndexerGeneration,
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
	ExistingStream,
	TxInclusionQuery,
	TxInclusionStatus,
	TxInclusionBasis,
	TxInclusionVerdict,
} from '@etherfold/core';
