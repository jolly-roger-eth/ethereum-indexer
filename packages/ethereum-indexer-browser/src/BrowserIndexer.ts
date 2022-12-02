import {
	EthereumIndexer,
	type EventProcessor,
	type LastSync,
	type EIP1193Provider,
	type ContractsInfo,
	IndexerConfig,
} from 'ethereum-indexer';

import {writable, type Writable} from 'sveltore';

import {logs} from 'named-logs';
const namedLogger = logs('ethereum-indexer-browser');

function formatLastSync(lastSync: LastSync): any {
	return filterOutFieldsFromObject(lastSync, ['_rev', '_id', 'batch']);
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
	catchingUp: boolean;
};

export class BrowserIndexer {
	protected indexer: EthereumIndexer;

	protected autoIndexing: boolean = false;
	protected catchingUp: boolean = false;
	protected loading: boolean = false;
	protected indexingTimeout: number | undefined;

	protected store: Writable<BrowserIndexerState>;

	constructor(
		protected processor: EventProcessor,
		protected contractsInfo: ContractsInfo,
		protected eip1193Provider: EIP1193Provider,

		protected indexerConfig?: IndexerConfig
	) {
		this.store = writable({
			loading: this.loading,
			autoIndexing: this.autoIndexing,
			catchingUp: this.catchingUp,
		});
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

		this.store.update((state) => {
			state.lastSync = lastSyncObject;
			return state;
		});
	}

	async indexMore(): Promise<LastSync> {
		if (!this.indexer) {
			await this.setupIndexing();
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
		this.store.update((state) => {
			state.catchingUp = true;
			this.catchingUp = true;
			return state;
		});
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
		this.store.update((state) => {
			state.catchingUp = false;
			this.catchingUp = false;
			return state;
		});
		namedLogger.info(`... done.`);
		return lastSync;
	}

	private async setupIndexing(): Promise<LastSync> {
		namedLogger.info(`setting up indexer...`);
		this.indexer = new EthereumIndexer(this.eip1193Provider, this.processor, this.contractsInfo, this.indexerConfig);

		namedLogger.info(`loading...`);
		this.store.update((state) => {
			state.loading = true;
			this.loading = true;
			return state;
		});
		const lastSync = await this.indexer.load();
		this.store.update((state) => {
			state.loading = false;
			this.loading = false;
			return state;
		});

		return lastSync;
	}

	async startAutoIndexing(): Promise<boolean> {
		if (!this.indexer) {
			await this.setupIndexing();
		}
		if (!this.autoIndexing) {
			this._auto_index();
			return true;
		} else {
			return false;
		}
	}

	stopAutoIndexing(): boolean {
		if (this.autoIndexing) {
			if (this.indexingTimeout) {
				clearTimeout(this.indexingTimeout);
			}

			this.store.update((state) => {
				state.autoIndexing = false;
				this.autoIndexing = false;
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
		this.store.update((state) => {
			state.autoIndexing = true;
			this.autoIndexing = true;
			return state;
		});
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
