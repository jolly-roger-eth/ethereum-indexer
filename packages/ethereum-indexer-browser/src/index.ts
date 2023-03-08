export {BrowserIndexer} from './BrowserIndexer';

// convenience : export type from ethereum-indexer

// typescript 5 export type * from 'ethereum-indexer';
export type {
	AllContractData,
	ContractData,
	IndexingSource,
	BlockEvents,
	EthereumIndexer,
	EventBlock,
	EventProcessor,
	EventWithId,
	ExistingStreamFecther,
	GenericABI,
	IndexerConfig,
	LastSync,
	LoadingState,
	LogEvent,
	LogEventFetcher,
	LogFetcher,
	LogFetcherConfig,
} from 'ethereum-indexer';
