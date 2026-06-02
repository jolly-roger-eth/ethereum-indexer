import {Abi, EthereumIndexer, IndexingSource, KeepState} from 'ethereum-indexer';
import type {Options} from './types.js';
import {logs} from 'named-logs';
import {JSONRPCHTTPProvider} from 'eip-1193-jsonrpc-provider';
import {EIP1193ProviderWithoutEvents} from 'eip-1193';
import {instantiateProcessor, loadContracts, loadProcessorModule, resolveSource} from 'ethereum-indexer-utils';
import {createFileKeepState} from './keepState.js';

const logger = logs('ei');

type ProcessorWithKeepState<ABI extends Abi> = {
	keepState(keeper: KeepState<ABI, any, {history: any}, any>): void;
};

export async function init<ABI extends Abi, ProcessResultType>(options: Options) {
	// The CLI owns its provider construction (rate-limited JSON-RPC). The processor/source resolution
	// logic is shared with the server via the helpers in ethereum-indexer-utils.
	logger.info({
		nodeUrl: options.nodeUrl,
	});
	const eip1193Provider = new JSONRPCHTTPProvider(options.nodeUrl, {requestsPerSecond: options.rps});

	let source: IndexingSource<ABI> | undefined = options.deployments ? loadContracts(options.deployments) : undefined;

	// Use the granular helpers (rather than the bundled `resolveProcessorAndSource`) so the original
	// CLI ordering is preserved exactly: instantiate the processor and run the keepState check BEFORE
	// resolving the source. This keeps a missing-keepState processor failing without first issuing an
	// `eth_chainId` RPC, matching the previous behaviour. The CLI intentionally constructs the
	// processor with NO factory argument (the server passes its folder); see MEDIUM-3.
	const processorModule = await loadProcessorModule<ABI, ProcessResultType>(options.processor);
	const processor = instantiateProcessor<ABI, ProcessResultType>(processorModule, {processorPath: options.processor});

	if (!(processor as any).keepState) {
		throw new Error(`this processor do not support "keepState" config`);
	}

	(processor as unknown as ProcessorWithKeepState<ABI>).keepState(createFileKeepState<ABI>(options.folder));

	if (!source) {
		source = await resolveSource<ABI, ProcessResultType>(
			processorModule,
			eip1193Provider as unknown as EIP1193ProviderWithoutEvents,
		);
	}

	if (!source || !source.contracts) {
		throw new Error(
			`contracts data not found in the processor module, it needs to be provided either as exported field named "contractsData" or as field "contractsDataPerChain" indexed by chainID`,
		);
	}

	const indexer = new EthereumIndexer(eip1193Provider as unknown as EIP1193ProviderWithoutEvents, processor, source, {
		providerSupportsETHBatch: true,
	});

	logger.info(`LOADING....`);
	const lastSync = await indexer.load();
	return {lastSync, indexer, eip1193Provider, processor};
}

// Minimal shape needed to drive the batch loop (the real EthereumIndexer satisfies it). Kept loose
// so `indexToTip` can be unit-tested with a fake indexer.
type IndexMoreLike = {
	indexMore(): Promise<{lastToBlock: number; latestBlock: number} & Record<string, any>>;
};

const wait = (seconds: number) => new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000));

// Drive `indexMore()` until the indexer reaches the chain tip (lastToBlock >= latestBlock), with
// bounded retry on transient errors so a single RPC blip does not abort the whole batch.
//
// Termination contract: this follows the *live* tip each iteration (indexMore re-fetches the latest
// block), i.e. it indexes "up to the current head" rather than a head pinned at start. For the
// snapshot use case (snapshots are taken behind finality) this is the intended behaviour.
export async function indexToTip(
	indexer: IndexMoreLike,
	opts?: {
		maxRetriesPerStep?: number;
		retryDelaySeconds?: number;
		onError?: (err: unknown, attempt: number) => void;
		waitFn?: (seconds: number) => Promise<void>;
	},
): Promise<{lastToBlock: number; latestBlock: number} & Record<string, any>> {
	const maxRetries = opts?.maxRetriesPerStep ?? 5;
	const retryDelay = opts?.retryDelaySeconds ?? 1;
	const waitFn = opts?.waitFn ?? wait;
	const onError = opts?.onError ?? ((err, attempt) => console.error(`indexMore failed (attempt ${attempt})`, err));

	async function indexMoreWithRetry() {
		let attempt = 0;
		// eslint-disable-next-line no-constant-condition
		while (true) {
			try {
				return await indexer.indexMore();
			} catch (err) {
				attempt++;
				onError(err, attempt);
				if (attempt > maxRetries) {
					throw err;
				}
				await waitFn(retryDelay);
			}
		}
	}

	// First pass establishes the current tip (latestBlock) without a separate eth_blockNumber call.
	let newLastSync = await indexMoreWithRetry();
	while (newLastSync.lastToBlock < newLastSync.latestBlock) {
		newLastSync = await indexMoreWithRetry();
	}
	return newLastSync;
}

export async function run(options: Options) {
	logger.info(JSON.stringify(options, null, 2));
	const {indexer, processor} = await init(options);
	let state: any;
	indexer.onStateUpdated = (newState) => {
		state = newState;
	};
	indexer.onLastSyncUpdated = (sync) => {
		console.log(`${sync.lastToBlock} / ${sync.latestBlock}`);
	};

	await indexToTip(indexer);
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
	const runFn = deps?.run ?? run;
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
