import {
	Abi,
	AllContractData,
	ContractData,
	EthereumIndexer,
	EventProcessor,
	IndexingSource,
	KeepState,
} from 'ethereum-indexer';
import type {Options} from './types.js';
import {logs} from 'named-logs';
import {JSONRPCHTTPProvider} from 'eip-1193-jsonrpc-provider';
import {EIP1193ProviderWithoutEvents} from 'eip-1193';
import path from 'node:path';
import {loadContracts} from 'ethereum-indexer-utils';
import {createFileKeepState} from './keepState.js';

const logger = logs('ei');

type ProcessorWithKeepState<ABI extends Abi> = {
	keepState(keeper: KeepState<ABI, any, {history: any}, any>): void;
};

// TODO ethereum-indexer-server could reuse
export async function init<ABI extends Abi, ProcessResultType>(options: Options) {
	let processor: EventProcessor<ABI, ProcessResultType> | undefined;
	let source: IndexingSource<ABI> | undefined;

	if (options.deployments) {
		source = loadContracts(options.deployments);
	}

	let processorModule: any | undefined;
	if (path.isAbsolute(options.processor)) {
		processorModule = await import(options.processor);
	} else {
		processorModule = await import(path.join(process.cwd(), options.processor));
	}
	const processorFactory = processorModule.createProcessor as (config?: any) => EventProcessor<ABI, ProcessResultType>;

	if (!processorFactory) {
		throw new Error(
			`processor field could not be found: check module at ${options.processor} if it exports a "processor" field`,
		);
	}

	if (typeof processorFactory === 'function') {
		// TODO processor options
		processor = processorFactory();

		if (!processor) {
			throw new Error(
				`Processor could not be created, check the function exported as "processor" in module ${options.processor}`,
			);
		}
	} else {
		processor = processorFactory;
	}

	if (!(processor as any).keepState) {
		throw new Error(`this processor do not support "keepState" config`);
	}

	(processor as unknown as ProcessorWithKeepState<ABI>).keepState(createFileKeepState<ABI>(options.folder));

	logger.info({
		nodeUrl: options.nodeUrl,
	});
	const eip1193Provider = new JSONRPCHTTPProvider(options.nodeUrl, {requestsPerSecond: options.rps});

	let contractsData: AllContractData<ABI> | ContractData<ABI>[] | undefined;
	if (!source) {
		let chainIDAsDecimal: string | undefined;

		if (processorModule.contractsDataPerChain) {
			let chainIDAsHex: `0x${string}`;
			try {
				chainIDAsHex = (await eip1193Provider.request({method: 'eth_chainId'})) as `0x${string}`;
			} catch (err) {
				console.error(`could not fetch chainID`);
				throw err;
			}
			chainIDAsDecimal = '' + parseInt(chainIDAsHex.slice(2), 16);
			logger.info(processorModule.contractsDataPerChain);
			logger.info({chainIDAsHex, chainIDAsDecimal});
			contractsData = processorModule.contractsDataPerChain[chainIDAsDecimal];
		}
		if (!contractsData) {
			contractsData = processorModule.contractsData;
		}

		if (processorModule.contractsDataPerChain && !contractsData) {
			console.error(`field "contractsDataPerChain" found but no contracts data found for chainID: ${chainIDAsDecimal}`);
		}

		if (!chainIDAsDecimal) {
			throw new Error(`no chainId found`);
		}

		if (!contractsData) {
			throw new Error(`no contracts data found`);
		}

		source = {
			chainId: chainIDAsDecimal,
			contracts: contractsData,
		};
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
