import {
	Abi,
	AllContractData,
	ContractData,
	EthereumIndexer,
	EventProcessor,
	IndexingSource,
	KeepState,
	ProcessorContext,
} from 'ethereum-indexer';
import type {Options} from './types';
import {logs} from 'named-logs';
import {JSONRPCHTTPProvider} from 'eip-1193-json-provider';
import {EIP1193ProviderWithoutEvents} from 'eip-1193';
import fs from 'fs';
import {loadContracts} from './utils/contracts';
import {bnReplacer, bnReviver} from './utils/bn';

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

	const processorModule = await import(options.processor);
	const processorFactory = processorModule.createProcessor as (config?: any) => EventProcessor<ABI, ProcessResultType>;

	if (!processorFactory) {
		throw new Error(
			`processor field could not be found: check module at ${options.processor} if it exports a "processor" field`
		);
	}

	if (typeof processorFactory === 'function') {
		// TODO processor options
		processor = processorFactory();

		if (!processor) {
			throw new Error(
				`Processor could not be created, check the function exported as "processor" in module ${options.processor}`
			);
		}
	} else {
		processor = processorFactory;
	}

	if (!(processor as any).keepState) {
		throw new Error(`this processor do not support "keepState" config`);
	}
	(processor as unknown as ProcessorWithKeepState<ABI>).keepState({
		fetch: async (context: ProcessorContext<ABI, any>) => {
			try {
				const content = fs.readFileSync(options.file, 'utf-8');
				const json = JSON.parse(content, bnReviver);
				return {
					state: json.state,
					lastSync: json.lastSync,
					history: json.history,
				};
			} catch {
				return undefined as any; // TODO fix type in KeepState to allow undefined
			}
		},
		save: async (context, all) => {
			const data = {lastSync: all.lastSync, state: all.state, history: all.history};
			fs.writeFileSync(options.file, JSON.stringify(data, bnReplacer, 2));
		},
		clear: async () => {},
	});

	logger.info({
		nodeUrl: options.nodeUrl,
	});
	const eip1193Provider = new JSONRPCHTTPProvider(options.nodeUrl);

	let contractsData: AllContractData<ABI> | ContractData<ABI>[] | undefined;
	if (!source) {
		let chainIDAsDecimal: string | undefined;

		if (processorModule.contractsDataPerChain) {
			let chainIDAsHex;
			try {
				chainIDAsHex = await eip1193Provider.request<string>({method: 'eth_chainId'});
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
			`contracts data not found in the processor module, it needs to be provided either as exported field named "contractsData" or as field "contractsDataPerChain" indexed by chainID`
		);
	}

	const indexer = new EthereumIndexer(eip1193Provider as unknown as EIP1193ProviderWithoutEvents, processor, source, {
		providerSupportsETHBatch: true,
	});

	logger.info(`LOADING....`);
	const lastSync = await indexer.load();
	return {lastSync, indexer, eip1193Provider, processor};
}

export async function run(options: Options) {
	logger.info(JSON.stringify(options, null, 2));
	const {indexer, lastSync, eip1193Provider, processor} = await init(options);
	const latestBlockNumberAsHex: string = await eip1193Provider.request({method: 'eth_blockNumber'});
	const lastBlockNumber = parseInt(latestBlockNumberAsHex.slice(2), 16);
	let newLastSync = {...lastSync, latestBlock: lastBlockNumber};
	let state: any;
	indexer.onStateUpdated = (newState) => {
		state = newState;
	};
	indexer.onLastSyncUpdated = (sync) => {
		console.log(`${sync.lastToBlock} / ${sync.latestBlock}`);
	};

	while (newLastSync.lastToBlock < newLastSync.latestBlock) {
		newLastSync = await indexer.indexMore();
	}

	// const data = {lastSync: newLastSync, state};
	// fs.writeFileSync(options.file, JSON.stringify(data, bnReplacer, 2));
}
