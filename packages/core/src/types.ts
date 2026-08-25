import type {Abi} from 'abitype';
import type {EIP1193DATA, EIP1193Log, EIP1193QUANTITY} from 'eip-1193';
import type {DecodeEventLogReturnType} from 'viem';
import type {NumberifiedLog} from './internal/decoding/LogEventFetcher.js';
import type {LogTransactionData} from './internal/engine/ethereum.js';
import type {LogFetcherConfig} from './internal/engine/RangeLogFetcher.js';
import type {JSONObject} from './internal/types.js';

export type EventBlock<ABI extends Abi> = {
	number: number;
	hash: string;
	events: LogEvent<ABI>[]; //this could be replacec by start: number;end: number but we would need access to the old coreresponding events
};

export type LogParsedData<ABI extends Abi> = DecodeEventLogReturnType<ABI>;
export type BaseLogEvent<Extra extends JSONObject | undefined = undefined> = NumberifiedLog & {
	removedStreamID?: number;
} & {
	extra: Extra;
	blockTimestamp?: number;
	transaction?: LogTransactionData;
};
export type ParsedLogEvent<ABI extends Abi, Extra extends JSONObject | undefined = undefined> = BaseLogEvent<Extra> &
	LogParsedData<ABI>;
export type LogEventWithParsingFailure<Extra extends JSONObject | undefined = undefined> = BaseLogEvent<Extra> & {
	decodeError: string;
};
export type LogEvent<ABI extends Abi, Extra extends JSONObject | undefined = undefined> =
	| ParsedLogEvent<ABI, Extra>
	| LogEventWithParsingFailure<Extra>;

export type EventProcessor<ABI extends Abi, ProcessResultType = void> = {
	getVersionHash(): string;
	/**
	 * A hash of the processor's own handler SOURCE, or `undefined` when it cannot
	 * be derived.
	 *
	 * Advisory, and deliberately NOT part of `getVersionHash()`: it moves when a
	 * minifier or a transpiler re-emits the same behaviour differently, and
	 * folding that into the version hash would force a full state rebuild on a
	 * deploy that changed no logic. The core only compares it, reports when it
	 * differs at an UNCHANGED version hash (the "forgot to bump" case), and never
	 * discards state because of it.
	 *
	 * REQUIRED, unlike the value it returns. An optional method is a hole with a
	 * polite name: an implementation that simply never wrote one would lose drift
	 * detection silently, and a WRAPPER (a cache, a decorator) that forgot to
	 * forward it would take the wrapped processor's detection down with it,
	 * invisibly. Being required makes both a compile error instead. Returning
	 * `undefined` is still allowed, because "cannot tell" is a real answer (a
	 * processor whose handlers are all bound or proxied has no readable source),
	 * and the core reads it as "do not report" rather than as "unchanged".
	 */
	getCodeFingerprint(): string | undefined;
	load: (
		source: IndexingSource<ABI>,
		streamConfig: UsedStreamConfig,
	) => Promise<{state: ProcessResultType; lastSync: LastSync<ABI>} | undefined>;
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

export type IncludedEIP1193Log = EIP1193Log & {
	blockNumber: EIP1193DATA;
	logIndex: EIP1193DATA;
	blockHash: EIP1193DATA;
	transactionIndex: EIP1193QUANTITY;
	transactionHash: EIP1193DATA;
};

export type ContextIdentifier = {
	source: {startBlock: number; hash: string}[];
	config: string;
	processor: string;
	/**
	 * The `getCodeFingerprint()` of the processor that computed this state.
	 *
	 * OPTIONAL, and it must stay optional: every cursor persisted before
	 * fingerprints existed lacks the field, so absence has to mean "unknown, do
	 * not report" rather than "drifted". Otherwise every existing deployment
	 * reports drift once on upgrade and the report stops being believed.
	 *
	 * It rides inside `ContextIdentifier` rather than beside it because
	 * `lastSync` is the one thing EVERY persistence path round-trips whole (the
	 * fs / localStorage / IndexedDB keepers, the CLI snapshot envelope, and the
	 * sync cursor a `StateStore` keeps behind the storage seam). It is NOT part of
	 * `indexerMatches`, which decides whether to discard state.
	 */
	processorFingerprint?: string;
};

/**
 * What the core reports when a processor's declared version says "unchanged"
 * and its code says otherwise. Advisory: the state is still adopted, unless
 * `strictProcessorDrift` is set.
 */
export type ProcessorDriftReport = {
	/** The version hash both sides agree on, which is what makes this drift rather than an upgrade. */
	processorHash: string;
	/** The fingerprint of the code that computed the persisted state. */
	storedFingerprint: string;
	/** The fingerprint of the code loaded now. */
	currentFingerprint: string;
	/** The same thing in words, as logged. */
	message: string;
};

export type LastSync<ABI extends Abi> = {
	context: ContextIdentifier;
	latestBlock: number;
	lastFromBlock: number;
	lastToBlock: number;
	unconfirmedBlocks: EventBlock<ABI>[];
};

/**
 * WHICH indexer a batch of logs is for, as the sender can assert it.
 *
 * Two of `ContextIdentifier`'s three identities and deliberately not the third:
 * a log-fetcher has no idea which processor version runs on the receiving side,
 * so `processor` is the receiver's own business (ADR-0004). The two that ARE
 * here are the ones both halves compute from the same declarations, which is
 * what makes comparing them a real check rather than an echo.
 */
export type WireContext = {
	source: {startBlock: number; hash: string}[];
	config: string;
};

/**
 * What crosses the wire from a log-fetcher to an indexer-server: a contiguous
 * block range and every log in it.
 *
 * ## `logs` are DECODED events, not the JSON-RPC shape
 *
 * ADR-0004 calls them "raw logs", and that means raw as opposed to the
 * reorg-annotated emission stream a processor consumes: no `removed` markers,
 * no retractions, nothing the receiver has to derive. It does NOT mean the
 * undecoded `eth_getLogs` result. The sender decodes (`captureStream` is exactly
 * that job) and ships `LogEvent`s, for two reasons: the receiver's primitive
 * (`generateStreamToAppend`) takes decoded events, and the sender already holds
 * the ABI it needs, since a source IS its contracts. The cost is a larger
 * payload, because `args` restates what `data` and `topics` already encode;
 * `data` and `topics` are still carried, so the receiver can re-derive or store
 * the original bytes (ADR-0006 needs them).
 *
 * This is the whole envelope of ADR-0004 and it is deliberately small. What is
 * NOT here is as load-bearing as what is:
 *
 * - no `complete` flag, because completeness is an invariant (see
 *   `InvalidBatchError`);
 * - no `removed` markers and no `unconfirmedBlocks`, because the receiver
 *   derives every reorg itself, so that logic exists in exactly one place;
 * - no cursor from the sender, because the receiver owns the cursor.
 */
export type WireBatch<ABI extends Abi> = {
	context: WireContext;
	fromBlock: number;
	toBlock: number;
	/** The chain tip the sender observed, which is what bounds the unconfirmed window. */
	latestBlock: number;
	logs: LogEvent<ABI>[];
};

/**
 * The same envelope, for a host that transports it without decoding it.
 *
 * An HTTP route reads a body, hands it to the receiver and writes a status code;
 * it never looks inside a log. Typing it against this instead of `WireBatch<ABI>`
 * is what keeps a server package from having to be generic over the ABI of the
 * processor it happens to host, which it has no way to know and no use for.
 */
export type UntypedWireBatch = Omit<WireBatch<Abi>, 'logs'> & {logs: unknown[]};

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
	readonly genesisHash?: `0x${string}`;
};

export type StreamFetcher<ABI extends Abi> = (
	source: IndexingSource<ABI>,
	fromBlock: number,
) => Promise<{lastSync: LastSync<ABI>; eventStream: LogEvent<ABI>[]} | undefined>;
export type StreamSaver<ABI extends Abi> = (
	source: IndexingSource<ABI>,
	stream: {
		lastSync: LastSync<ABI>;
		eventStream: LogEvent<ABI>[];
	},
) => Promise<void>;
export type StreamClearer<ABI extends Abi> = (source: IndexingSource<ABI>) => Promise<void>;

type OptionsFlags<Type> = {
	[Property in keyof Type]: boolean;
};
type LogValuesFlags = OptionsFlags<NumberifiedLog>;

export type UsedStreamConfig = ProvidedStreamConfig & {
	finality: number;
};

export type ProvidedStreamConfig = {
	finality?: number;
	alwaysFetchTimestamps?: boolean;
	alwaysFetchTransactions?: boolean;
	parse?: LogParseConfig;
};

export type FetchConfig = Omit<LogFetcherConfig, 'filters'>;

export type ProvidedIndexerConfig<ABI extends Abi> = {
	fetch?: FetchConfig;
	stream?: ProvidedStreamConfig;
	providerSupportsETHBatch?: boolean;
	feedBatchSize?: number;
	keepStream?: ExistingStream<ABI>;
	skipGenesisCheck?: boolean;
	/**
	 * Turn a processor-drift report into a refusal to start (`load()` rejects).
	 *
	 * Off by default, because the fingerprint has real false positives: a
	 * re-minification changes handler source without changing behaviour. Fail
	 * loud by default, fail stop by choice. It sits here, next to
	 * `skipGenesisCheck`, because it is the same kind of thing: a load-time
	 * safety gate belonging to the deployment, not to the processor an author
	 * ships.
	 */
	strictProcessorDrift?: boolean;
	logLevel?: number;
};

export type UsedIndexerConfig<ABI extends Abi> = ProvidedIndexerConfig<ABI> & {
	stream: UsedStreamConfig;
	feedBatchSize: number;
};

export type ExistingStream<ABI extends Abi> = {
	fetchFrom: StreamFetcher<ABI>;
	saveNewEvents: StreamSaver<ABI>;
	clear: StreamClearer<ABI>;
};

export type LogParseConfig = {
	parseAllEventsIrrespectiveOfAddresses?: boolean;
	logValues?: LogValuesFlags;
	filters?: {
		// for each event name we can specify a list of filter
		// each filter is an array of (topic or topic[])
		// so this is an array of array of (topic | topic[])
		[eventName: string]: (`0x${string}` | `0x${string}`[])[][];
		// Note we do not provide type arg here (could have done it via abitype) because multiple event could share the same order
	};
};

/**
 * What a `KeepState` keeper is told about the processor whose state it is
 * storing.
 *
 * `version` is REQUIRED, because every processor now has one: it is validated at
 * construction (`assertProcessorVersion`), so an optional field here would only
 * describe a state that can no longer exist, and every keeper that reads it
 * would keep carrying a defensive branch for it.
 */
export type ProcessorContext<ABI extends Abi, ProcessorConfig> = ProcessorConfig extends undefined
	? {
			readonly source: IndexingSource<ABI>;
			version: string;
		}
	: {
			readonly source: IndexingSource<ABI>;
			readonly config: ProcessorConfig;
			version: string;
		};

export type AllData<ABI extends Abi, ProcessResultType, Extra> = {
	state: ProcessResultType;
	lastSync: LastSync<ABI>;
} & Extra;

export type ExistingStateFetcher<ABI extends Abi, ProcessResultType, Extra, ProcessorConfig> = (
	context: ProcessorContext<ABI, ProcessorConfig>,
) => Promise<AllData<ABI, ProcessResultType, Extra>>;
export type StateSaver<ABI extends Abi, ProcessResultType, Extra, ProcessorConfig> = (
	context: ProcessorContext<ABI, ProcessorConfig>,
	all: AllData<ABI, ProcessResultType, Extra>,
) => Promise<void>;

export type KeepState<ABI extends Abi, ProcessResultType, Extra, ProcessorConfig> = {
	fetch: ExistingStateFetcher<ABI, ProcessResultType, Extra, ProcessorConfig>;
	save: StateSaver<ABI, ProcessResultType, Extra, ProcessorConfig>;
	clear: (context: ProcessorContext<ABI, ProcessorConfig>) => Promise<void>;
};
