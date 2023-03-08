import {
	EthereumIndexer,
	type EventProcessor,
	type LastSync,
	type IndexingSource,
	IndexerConfig,
} from 'ethereum-indexer';
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

export type BrowserIndexerState<T = void> = {
	lastSync?: ExtendedLastSync;
	autoIndexing: boolean;
	loading: boolean;
	processingFetchedLogs: boolean;
	fetchingLogs: boolean;
	catchingUp: boolean;
	error?: {message: string; code: number};
	state?: T;
};

export class BrowserIndexer<T = void> {
	protected indexer: EthereumIndexer<T>;

	protected indexingTimeout: number | undefined;

	protected state: BrowserIndexerState<T>;
	protected store: Writable<BrowserIndexerState<T>>;

	protected processor: EventProcessor<T> | undefined;
	protected source: IndexingSource | undefined;
	protected eip1193Provider: EIP1193Provider | undefined;
	protected indexerConfig: IndexerConfig | undefined;

	constructor() {
		this.state = {
			loading: false,
			autoIndexing: false,
			catchingUp: false,
			fetchingLogs: false,
			processingFetchedLogs: false,
			state: void 0,
		};
		this.store = writable(this.state);
	}

	init(
		processor: EventProcessor<T>,
		source: IndexingSource,
		eip1193Provider: EIP1193Provider,
		indexerConfig: IndexerConfig
	) {
		this.processor = processor;
		this.source = source;
		this.eip1193Provider = eip1193Provider;
		this.indexerConfig = indexerConfig;
	}

	private set(lastSync: LastSync, state: T) {
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
		this.state.state = state;
		this.store.set(this.state);
	}

	async indexMore(): Promise<LastSync> {
		if (!this.indexer) {
			namedLogger.info('setting up...');
			await this.setupIndexing();
			namedLogger.info('...setup done');
		}
		const lastSync = await this.indexer.indexMore();
		this.set(lastSync, this.processor.state);
		return lastSync;
	}

	async indexToLatest(): Promise<LastSync> {
		let lastSync: LastSync | undefined;
		if (!this.indexer) {
			lastSync = await this.setupIndexing();
			this.set(lastSync, this.processor.state);
		}

		namedLogger.info(`indexing...`);
		this.state.catchingUp = true;
		this.store.set(this.state);
		try {
			lastSync = await this.indexer.indexMore();
			this.set(lastSync, this.processor.state);
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
				this.set(lastSync, this.processor.state);
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
		if (!this.source) {
			throw new Error(`no indexing source provided, did you call init ?`);
		}
		if (!this.indexerConfig) {
			throw new Error(`no config for indexer provided, did you call init ?`);
		}
		this.indexer = new EthereumIndexer(this.eip1193Provider, this.processor, this.source, this.indexerConfig);
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
		try {
			const lastSync = await this.indexer.load();
			namedLogger.info('...done loading');
			this.state.loading = false;
			this.store.set(this.state);

			return lastSync;
		} finally {
			this.state.loading = false;
			this.state.error = {message: 'Failed to load', code: 1}; // TODO code
			this.store.set(this.state);
		}
	}

	acknowledgeError() {
		this.state.error = undefined;
		this.store.set(this.state);
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

	subscribe(subscription: (value: BrowserIndexerState<T>) => void): () => void {
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
