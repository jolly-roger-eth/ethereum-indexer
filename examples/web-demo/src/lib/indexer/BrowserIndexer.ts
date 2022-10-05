import {
	EthereumIndexer,
	type EventProcessor,
	type LastSync,
	type EIP1193Provider,
	type ContractsInfo
} from 'ethereum-indexer';

import {writable, type Writable} from 'sveltore';

import {logs} from 'named-logs';
const namedLogger = logs('ethereum-index-browser');

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

export class BrowserIndexer {
	protected indexer: EthereumIndexer;

	protected indexing: boolean = false;
	protected indexingTimeout: number | undefined;

	protected store: Writable<LastSync>;

	constructor(
		protected processor: EventProcessor,
		protected contractsInfo: ContractsInfo,
		protected eip1193Provider: EIP1193Provider
	) {
		this.store = writable(undefined);
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

		this.store.set(lastSyncObject);
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
		if (!this.indexer) {
			await this.setupIndexing();
		}
		namedLogger.info(`indexing...`);
		let lastSync;
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
		namedLogger.info(`... done.`);
		return lastSync;
	}

	private async setupIndexing(): Promise<LastSync> {
		namedLogger.info(`setting up indexer...`);
		this.indexer = new EthereumIndexer(this.eip1193Provider, this.processor, this.contractsInfo, {
			providerSupportsETHBatch: true
		});
		return this.indexer.load();
	}

	async startAutoIndexing(): Promise<boolean> {
		if (!this.indexer) {
			await this.setupIndexing();
		}
		if (!this.indexing) {
			this._auto_index();
			return true;
		} else {
			return false;
		}
	}

	stopAutoIndexing(): boolean {
		if (this.indexing) {
			if (this.indexingTimeout) {
				clearTimeout(this.indexingTimeout);
			}
			this.indexing = false;
			return true;
		} else {
			return false;
		}
	}

	subscribe(subscription: (value: any) => void): () => void {
		return this.store.subscribe(subscription);
	}

	private async _auto_index() {
		this.indexing = true;
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
