import {EthereumIndexer, type EventProcessor, type LastSync, type ContractsInfo, IndexerConfig} from 'ethereum-indexer';
import {EIP1193Provider} from 'eip-1193';

import {writable, type Writable} from 'sveltore';

import {logs} from 'named-logs';
const namedLogger = logs('ethereum-indexer-browser');

function formatLastSync(lastSync: LastSync): any {
	return filterOutFieldsFromObject(lastSync, ['_rev', '_id', 'batch']);
}

function wait(seconds: number): Promise<void> {
	return new Promise<void>((resolve) => {
		globalThis.setTimeout(() => resolve(), seconds * 1000);
	});
}

function filterOutFieldsFromObject<T = Object, U = Object>(obj: T, fields: string[]): U {
	const keys = Object.keys(obj);
	const newObj: U = {} as U;
	for (const key of keys) {
		if (fields.includes(key)) {
			continue;
		}
		newObj[key] = obj[key];
	}
	return newObj;
}

export type ExtendedLastSync = LastSync & {
	numBlocksProcessedSoFar: number;
	syncPercentage: number;
	totalPercentage: number;
};

export type BrowserIndexerState = {
	lastSync?: ExtendedLastSync;
	autoIndexing: boolean;
	loading: boolean;
	processingFetchedLogs: boolean;
	fetchingLogs: boolean;
	catchingUp: boolean;
};

export class BrowserIndexer {
	protected indexer: EthereumIndexer;

	protected indexingTimeout: number | undefined;

	protected state: BrowserIndexerState;
	protected store: Writable<BrowserIndexerState>;

	protected processor: EventProcessor | undefined;
	protected contractsInfo: ContractsInfo | undefined;
	protected eip1193Provider: EIP1193Provider | undefined;
	protected indexerConfig: IndexerConfig | undefined;

	constructor() {
		this.state = {
			loading: false,
			autoIndexing: false,
			catchingUp: false,
			fetchingLogs: false,
			processingFetchedLogs: false,
		};
		this.store = writable(this.state);
	}

	init(
		processor: EventProcessor,
		contractsInfo: ContractsInfo,
		eip1193Provider: EIP1193Provider,
		indexerConfig: IndexerConfig
	) {
		this.processor = processor;
		this.contractsInfo = contractsInfo;
		this.eip1193Provider = eip1193Provider;
		this.indexerConfig = indexerConfig;
	}

	private set(lastSync: LastSync) {
		const startingBlock = this.indexer.defaultFromBlock;
		const latestBlock = lastSync.latestBlock;
		const lastToBlock = lastSync.lastToBlock;

		const totalToProcess = latestBlock - startingBlock;
		const numBlocksProcessedSoFar = Math.max(0, lastToBlock - startingBlock);

		const lastSyncObject = formatLastSync(lastSync);
		lastSyncObject.numBlocksProcessedSoFar = numBlocksProcessedSoFar;
		lastSyncObject.syncPercentage = Math.floor((numBlocksProcessedSoFar * 1000000) / totalToProcess) / 10000;
		lastSyncObject.totalPercentage = Math.floor((lastToBlock * 1000000) / latestBlock) / 10000;

		this.state.lastSync = lastSyncObject;
		this.store.set(this.state);
	}

	async indexMore(): Promise<LastSync> {
		if (!this.indexer) {
			namedLogger.info('setting up...');
			await this.setupIndexing();
			namedLogger.info('...setup done');
		}
		const lastSync = await this.indexer.indexMore();
		this.set(lastSync);
		return lastSync;
	}

	async indexToLatest(): Promise<LastSync> {
		let lastSync: LastSync | undefined;
		if (!this.indexer) {
			lastSync = await this.setupIndexing();
			this.set(lastSync);
		}

		namedLogger.info(`indexing...`);
		this.state.catchingUp = true;
		this.store.set(this.state);
		try {
			lastSync = await this.indexer.indexMore();
			this.set(lastSync);
		} catch (err) {
			namedLogger.error('ERROR, retry indexToLatest in 1 second', err);
			lastSync = await new Promise((resolve) => {
				setTimeout(async () => {
					const result = await this.indexToLatest();
					resolve(result);
				}, 1000);
			});
		}

		// const latestBlock = await this.eip1193Provider.request({method: 'eth_blockNumber', params:[]});
		while (lastSync.lastToBlock !== lastSync.latestBlock) {
			namedLogger.info(`indexing...`);
			try {
				lastSync = await this.indexer.indexMore();
				this.set(lastSync);
			} catch (err) {
				namedLogger.error('ERROR, retry indexing in 1 second', err);
				await new Promise((resolve) => {
					setTimeout(resolve, 1000);
				});
			}
		}
		this.state.catchingUp = false;
		this.store.set(this.state);
		namedLogger.info(`... done.`);
		return lastSync;
	}

	private async setupIndexing(): Promise<LastSync> {
		namedLogger.info(`setting up indexer...`);
		if (!this.processor) {
			throw new Error(`no processor provided, did you call init ?`);
		}
		if (!this.contractsInfo) {
			throw new Error(`no contracts info provided, did you call init ?`);
		}
		if (!this.indexerConfig) {
			throw new Error(`no config for indexer provided, did you call init ?`);
		}
		this.indexer = new EthereumIndexer(this.eip1193Provider, this.processor, this.contractsInfo, this.indexerConfig);
		this.indexer.onLoad = async (loadingState) => {
			if (loadingState === 'Loading') {
				namedLogger.info('indexer Loading');
				// this.store.update((state) => {
				// 	state.loading = true;
				// 	this.loading = true;
				// 	return state;
				// });
			} else if (loadingState === 'Fetching') {
				namedLogger.info('indexer Fetching');
				this.state.fetchingLogs = true;
				this.store.set(this.state);
			} else if (loadingState === 'Processing') {
				namedLogger.info('indexer Processing');
				this.state.fetchingLogs = false;
				this.state.processingFetchedLogs = true;
				this.store.set(this.state);
			} else if (loadingState === 'Done') {
				namedLogger.info('indexer Init DOne');
				this.state.processingFetchedLogs = false;
				this.store.set(this.state);
			}
			await wait(0.001); // allow svelte to capture it
		};

		namedLogger.info(`loading...`);
		this.state.loading = true;
		this.store.set(this.state);
		const lastSync = await this.indexer.load();
		namedLogger.info('...done loading');
		this.state.loading = false;
		this.store.set(this.state);

		return lastSync;
	}

	async startAutoIndexing(): Promise<boolean> {
		if (!this.indexer) {
			await this.setupIndexing();
		}
		if (!this.state.autoIndexing) {
			this._auto_index();
			return true;
		} else {
			return false;
		}
	}

	stopAutoIndexing(): boolean {
		if (this.state.autoIndexing) {
			if (this.indexingTimeout) {
				clearTimeout(this.indexingTimeout);
			}

			this.store.update((state) => {
				state.autoIndexing = false;
				this.state.autoIndexing = false;
				this.store.set(this.state);
				return state;
			});
			return true;
		} else {
			return false;
		}
	}

	subscribe(subscription: (value: BrowserIndexerState) => void): () => void {
		return this.store.subscribe(subscription);
	}

	private async _auto_index() {
		this.state.autoIndexing = true;
		this.store.set(this.state);
		try {
			const lastSync = await this.indexMore();
			if (lastSync.latestBlock - lastSync.lastToBlock < 1) {
				this.indexingTimeout = setTimeout(this._auto_index.bind(this), 1000);
			} else {
				this.indexingTimeout = setTimeout(this._auto_index.bind(this), 1);
			}
		} catch (err) {
			namedLogger.error('ERROR, retry in 1 seconds', err);
			this.indexingTimeout = setTimeout(this._auto_index.bind(this), 1000);
			return;
		}
	}
}
