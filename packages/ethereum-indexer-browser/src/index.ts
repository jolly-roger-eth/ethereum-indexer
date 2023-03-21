export * from './IndexerState';

export {hash} from 'ethereum-indexer';

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
	LogEventFetcher,
	LogFetcher,
	LogFetcherConfig,
	LogParseConfig,
	EventProcessorWithInitialState,
	AllData,
	ExistingStateFecther,
	StateSaver,
	ProcessorContext,
	ExistingStream,
} from 'ethereum-indexer';

export type {
	Abi,
	AbiConstructor,
	AbiError,
	AbiEvent,
	AbiFallback,
	AbiFunction,
	AbiInternalType,
	AbiItemType,
	AbiParameter,
	AbiParameterKind,
	AbiReceive,
	AbiStateMutability,
	AbiType,
	Address,
	SolidityAddress,
	SolidityArray,
	SolidityArrayWithTuple,
	SolidityArrayWithoutTuple,
	SolidityBool,
	SolidityBytes,
	SolidityFixedArrayRange,
	SolidityFixedArraySizeLookup,
	SolidityFunction,
	SolidityInt,
	SolidityString,
	SolidityTuple,
	TypedData,
	TypedDataDomain,
	TypedDataParameter,
	TypedDataType,
} from 'ethereum-indexer';

export type {Config, DefaultConfig, ResolvedConfig} from 'ethereum-indexer';

export type {
	AbiParameterToPrimitiveType,
	AbiParametersToPrimitiveTypes,
	AbiTypeToPrimitiveType,
	BaseError,
	ExtractAbiError,
	ExtractAbiErrorNames,
	ExtractAbiErrors,
	ExtractAbiEvent,
	ExtractAbiEventNames,
	ExtractAbiEvents,
	ExtractAbiFunction,
	ExtractAbiFunctionNames,
	ExtractAbiFunctions,
	IsAbi,
	IsTypedData,
	Narrow,
	ParseAbi,
	ParseAbiItem,
	ParseAbiParameter,
	ParseAbiParameters,
	TypedDataToPrimitiveTypes,
} from 'ethereum-indexer';
