import {
	createDirectIngestion,
	resolveStreamConfig,
	StreamBuilder,
	type Abi,
	type EventProcessor,
	type IndexingSource,
	type KeepState,
	type ProvidedStreamConfig,
} from '@etherfold/core';
import {
	createFetcherHost,
	resolveFetcherHostConfig,
	runFetcherLoop,
	type CycleReport,
	type FetcherHost,
	type RunSummary,
	type Sleep,
} from '@etherfold/fetcher-host';
import type {EntityProcessor, StateStore} from '@etherfold/processor-entities';
import {instantiateProcessorWithKind, loadContracts, loadProcessorModule, resolveSource} from '@etherfold/utils';
import type {EIP1193ProviderWithoutEvents} from 'eip-1193';
import {JSONRPCHTTPProvider} from 'eip-1193-jsonrpc-provider';
import {logs} from 'named-logs';
import type {RemoteSQL} from 'remote-sql';
import {createFileKeepState} from './keepState.js';
import {resolveIndexOptions} from './options.js';
import type {Options, StoreTarget} from './types.js';

const logger = logs('etherfold');

type ProcessorWithKeepState<ABI extends Abi> = {
	keepState(keeper: KeepState<ABI, any, {history: any}, any>): void;
};

/**
 * The stream configuration this command indexes under.
 *
 * Deliberately empty, and deliberately passed to BOTH halves: the resolved
 * object is hashed into the wire identity, so the sending `LogFetcher` and the
 * receiving `StreamBuilder` must reach the same `finality` from the same input.
 * Its RESOLVED form (`resolveStreamConfig`) is also what the entity store's
 * retention floor is checked against, which is why nothing here writes a
 * finality number of its own.
 */
const STREAM_CONFIG: ProvidedStreamConfig = {};

/** What a test (or a future `build`) may substitute for the real world. */
export type IndexingDependencies = {
	/** Loads the processor module. Defaults to a dynamic `import()`. */
	importModule?: (specifier: string) => Promise<any>;
	/** The chain. Defaults to the rate-limited JSON-RPC provider this CLI owns. */
	provider?: EIP1193ProviderWithoutEvents;
	/** Builds the libSQL handle for `--store sqlite`. Defaults to `createNodeDB`. */
	createDB?: (url: string) => RemoteSQL;
	/** The wait between cycles. Defaults to a real sleep. */
	sleep?: Sleep;
	/** Stops the run from outside, the way a signal handler would. */
	signal?: AbortSignal;
	/** Every cycle report, in order, after this command has acted on it. */
	onReport?: (report: CycleReport) => void;
	/** The environment flags fall back to. Defaults to `process.env`. */
	env?: Record<string, string | undefined>;
};

/** Everything the assembled pipeline is made of, so a caller can drive it and look at it. */
export type PreparedIndexing<ABI extends Abi = Abi, ProcessResultType = unknown> = {
	source: IndexingSource<ABI>;
	processor: EventProcessor<ABI, ProcessResultType>;
	/** The receiving half. Present so a test can assert WHICH engine folds, rather than trust it. */
	streamBuilder: StreamBuilder<ABI, ProcessResultType>;
	/** The sending half, plus the policy for reading what a cycle did. */
	host: FetcherHost<ABI>;
	/** The entity store, on `--store sqlite` only: the free-form path has a keeper instead. */
	store?: StateStore;
	/** Run cycles until the tip, and return what the run did. Throws on a `fatal` report. */
	index(): Promise<RunSummary>;
};

/**
 * Assemble the two ADR-0003 halves in one process, with the transport removed.
 *
 * ```
 * LogFetcher -> createDirectIngestion -> StreamBuilder -> EventProcessor -> (a keeper | a StateStore)
 * ```
 *
 * ## Why this and not `EthereumIndexer`
 *
 * Because there is one server-side folding engine or there are two.
 * `work/specs/ready/one-command-runs-the-whole-pipeline.md` builds `run` and
 * `index` on the same `StreamBuilder` and asserts they produce identical state
 * from the same input; that assertion is worth making only if the transport is
 * the only difference between them. Folding here through a second engine would
 * turn it into an equivalence between two IMPLEMENTATIONS that happen to agree
 * today. `EthereumIndexer` also cannot be split into halves at all (it opens
 * `load()` with `eth_chainId`, which is why the chain-free `StreamBuilder`
 * exists), and what it has that a server does not want is the kept-stream CACHE:
 * here the folder or the database IS the durable artifact. It stays the
 * browser's engine and is not constructed anywhere in this path.
 *
 * ## The order of what happens here is part of the contract
 *
 * The processor is loaded, its KIND is read off the module and checked against
 * `--store`, and the state destination is built -- all BEFORE the source is
 * resolved, which is the first thing that can touch the chain. So a mismatch
 * fails without first issuing `eth_chainId`, exactly as the keeper-less refusal
 * this replaces did.
 */
export async function prepareIndexing<ABI extends Abi, ProcessResultType>(
	options: Options,
	deps: IndexingDependencies = {},
): Promise<PreparedIndexing<ABI, ProcessResultType>> {
	const resolved = resolveIndexOptions(options);

	logger.info({nodeUrl: resolved.nodeUrl, store: resolved.target.store});

	// The CLI owns its provider construction (rate-limited JSON-RPC). The processor/source resolution
	// logic is shared with the server via the helpers in @etherfold/utils.
	const provider =
		deps.provider ??
		(new JSONRPCHTTPProvider(resolved.nodeUrl, {
			requestsPerSecond: resolved.rps,
		}) as unknown as EIP1193ProviderWithoutEvents);

	// The CLI intentionally constructs the processor with NO factory argument (the server passes its
	// folder); see MEDIUM-3.
	const processorModule = await loadProcessorModule<ABI, ProcessResultType>(resolved.processor, {
		...(deps.importModule ? {importModule: deps.importModule} : {}),
	});
	const declared = instantiateProcessorWithKind<ABI, ProcessResultType, EntityProcessor<ABI, any>>(processorModule, {
		processorPath: resolved.processor,
	});

	assertKindMatchesStore(declared.kind, resolved.target, resolved.processor);

	const streamConfig = resolveStreamConfig(STREAM_CONFIG);
	const {processor, store} = await buildProcessor<ABI, ProcessResultType>(declared, resolved.target, {
		finalityDepth: streamConfig.finality,
		processorPath: resolved.processor,
		...(deps.createDB ? {createDB: deps.createDB} : {}),
	});

	let source: IndexingSource<ABI> | undefined = resolved.deployments ? loadContracts(resolved.deployments) : undefined;
	if (!source) {
		source = await resolveSource<ABI, ProcessResultType>(processorModule, provider as never);
	}
	if (!source || !source.contracts) {
		throw new Error(
			`contracts data not found in the processor module, it needs to be provided either as exported field named "contractsData" or as field "contractsDataPerChain" indexed by chainID`,
		);
	}

	// The receiving half of ADR-0004: authoritative about the cursor, derives every reorg, makes no
	// chain call. It reads the persisted cursor on every batch rather than holding one, which is what
	// makes an interrupted run resume from the store instead of from the start block.
	const streamBuilder = new StreamBuilder<ABI, ProcessResultType>(processor, source, {stream: STREAM_CONFIG});

	const host = createFetcherHost<ABI>(
		resolveFetcherHostConfig<ABI>(deps.env ?? process.env, {
			source,
			nodeUrl: resolved.nodeUrl,
			stream: STREAM_CONFIG,
			...(resolved.rps === undefined ? {} : {requestsPerSecond: resolved.rps}),
		}),
		{
			provider,
			// the wire with no wire: the same two components a split deployment runs, in
			// one process, with nothing between them
			target: createDirectIngestion(streamBuilder),
		},
	);

	return {
		source,
		processor,
		streamBuilder,
		host,
		...(store ? {store} : {}),
		index: () => indexToTip(host, deps),
	};
}

/**
 * Run cycles until this command has nothing left to do, then stop.
 *
 * `runFetcherLoop` follows the tip forever and has no stop-at-tip option, which
 * is right for a host that is meant to keep running; a one-shot is that same
 * loop plus an `AbortController` aborted from `onReport`. Two reports mean the
 * work is done: a `progress` that reached the tip it observed (`caughtUp`), and
 * an `idle` (there was nothing above the cursor to fetch). Everything else is
 * the loop's own business -- a `retry` backs off and tries again, a `fatal` ends
 * the loop by itself and is re-thrown here so the process exits non-zero.
 *
 * Deliberately NOT a stop on `contended`: a yielded cycle means another sender
 * moved the cursor, and stopping there would report success having landed
 * nothing.
 */
async function indexToTip<ABI extends Abi>(host: FetcherHost<ABI>, deps: IndexingDependencies): Promise<RunSummary> {
	const controller = new AbortController();
	const stop = () => controller.abort();
	if (deps.signal?.aborted) {
		controller.abort();
	} else {
		deps.signal?.addEventListener('abort', stop, {once: true});
	}

	try {
		const summary = await runFetcherLoop(host, {
			signal: controller.signal,
			...(deps.sleep ? {sleep: deps.sleep} : {}),
			onReport: (report) => {
				if (report.kind === 'progress') {
					console.log(`${report.outcome.toBlock} / ${report.outcome.latestBlock}`);
				}
				deps.onReport?.(report);
				if (report.kind === 'idle' || (report.kind === 'progress' && report.caughtUp)) {
					controller.abort();
				}
			},
		});

		if (summary.stoppedBecause === 'fatal') {
			// A refusal no waiting fixes: a foreign {source, config}, the wrong chain, a
			// suspected truncation. It is re-thrown so `main` resolves a non-zero exit
			// code and a CI job can depend on it rather than on parsing output.
			throw summary.error;
		}
		return summary;
	} finally {
		deps.signal?.removeEventListener('abort', stop);
	}
}

/**
 * The kind the MODULE declares against the store the OPERATOR named.
 *
 * A mismatch is refused loudly, naming both, and it is refused HERE -- before
 * the source is resolved -- so it never costs an RPC call. It is not repaired by
 * guessing which of the two the user meant: an entity processor writing into a
 * state blob and a free-form object writing into entity tables are not
 * near-misses, they are two different persistence models.
 */
function assertKindMatchesStore(kind: 'js-object' | 'entities', target: StoreTarget, processorPath: string): void {
	if (kind === 'entities' && target.store === 'file') {
		throw new Error(
			`the processor module at ${processorPath} declares kind 'entities', and --store file keeps a free-form ` +
				`state blob through a keepState keeper. An entity processor has no keepState: its state AND its sync ` +
				`cursor live in a StateStore, written in one transaction (ADR-0027). Run it with ` +
				`--store sqlite --db <libsql url>.`,
		);
	}
	if (kind === 'js-object' && target.store === 'sqlite') {
		throw new Error(
			`the processor module at ${processorPath} is a 'js-object' processor (an untagged module is one), and ` +
				`--store sqlite keeps versioned ENTITY rows. A free-form object declares no entities, so there is ` +
				`nothing for the store to lay out. Run it with --store file --folder <path>, or port it to an ` +
				`EntityProcessor and have the module return {kind: 'entities', processor}.`,
		);
	}
}

/**
 * Build the `EventProcessor` the stream-builder drives, plus the store it writes
 * to where there is one.
 *
 * Both arms hand back an `EventProcessor`, which is why the fetch-and-fold
 * wiring above is written once: what changes between `--store file` and
 * `--store sqlite` is the processor and where its state lives, never how logs
 * reach it.
 *
 * The sqlite arm's imports are dynamic so that `--store file` does not pay for
 * libSQL, matching how `serve` keeps the server's dependency tree off this
 * command.
 */
async function buildProcessor<ABI extends Abi, ProcessResultType>(
	declared:
		| {kind: 'js-object'; processor: EventProcessor<ABI, ProcessResultType>}
		| {kind: 'entities'; processor: EntityProcessor<ABI, any>},
	target: StoreTarget,
	context: {finalityDepth: number; processorPath: string; createDB?: (url: string) => RemoteSQL},
): Promise<{processor: EventProcessor<ABI, ProcessResultType>; store?: StateStore}> {
	if (declared.kind === 'js-object' && target.store === 'file') {
		const processor = declared.processor;
		if (!(processor as any).keepState) {
			throw new Error(`this processor do not support "keepState" config`);
		}
		(processor as unknown as ProcessorWithKeepState<ABI>).keepState(createFileKeepState<ABI>(target.folder));
		return {processor};
	}

	if (declared.kind !== 'entities' || target.store !== 'sqlite') {
		// `assertKindMatchesStore` ran first and refuses every other pairing, naming
		// both. Reaching here would mean it and this function disagree about what the
		// pairs are, which is worth a loud line rather than a silent branch.
		throw new Error(`unreachable: a '${declared.kind}' processor on --store ${target.store} is not a wiring`);
	}

	const [{EntityEventProcessor}, {VersionedStateStore}, {createNodeDB}] = await Promise.all([
		import('@etherfold/processor-entities'),
		import('@etherfold/state-store-sqlite'),
		import('@etherfold/platform-nodejs'),
	]);

	const handle = context.createDB ? context.createDB(target.db) : createNodeDB(target.db);
	// The finality depth is the stream's own, resolved once above: a retention
	// window is validated against the depth a reorg can actually reach, and a
	// number written here instead would be a second opinion about it.
	const store = new VersionedStateStore(handle, declared.processor.entities, {
		retention: target.retention,
		finalityDepth: context.finalityDepth,
	});
	// No keeper, and no cursor of our own: the store holds the rows and the cursor
	// in one transaction, and the stream-builder reads that persisted cursor on
	// every call. Nothing here prunes: pruning is a call a host schedules
	// (ADR-0022), and one inside the index loop would stall whichever block
	// crossed the threshold.
	const processor = new EntityEventProcessor<ABI, any>(store, declared.processor, {
		finalityDepth: context.finalityDepth,
	});
	return {processor: processor as unknown as EventProcessor<ABI, ProcessResultType>, store};
}

/** Assemble the pipeline and drive it to the tip. */
export async function run(options: Options, deps: IndexingDependencies = {}): Promise<RunSummary> {
	logger.info(JSON.stringify(options, null, 2));
	const prepared = await prepareIndexing<Abi, unknown>(options, deps);
	return prepared.index();
}

// Run the indexer and resolve the process exit code: 0 on success, 1 on failure. The `run`,
// `exit`, `log` and `error` collaborators are injectable so the success/failure contract can be
// unit-tested without driving the real process. `cli.ts` calls this with `process.exit`.
export async function main(
	options: Options,
	deps?: {
		run?: (options: Options) => Promise<unknown>;
		exit?: (code: number) => void;
		log?: (...args: any[]) => void;
		error?: (...args: any[]) => void;
	},
): Promise<void> {
	const runFn = deps?.run ?? ((opts: Options) => run(opts));
	const exit = deps?.exit ?? ((code: number) => process.exit(code));
	const log = deps?.log ?? console.log;
	const error = deps?.error ?? console.error;
	try {
		await runFn(options);
		log('DONE');
		exit(0);
	} catch (err) {
		error(err);
		exit(1);
	}
}
