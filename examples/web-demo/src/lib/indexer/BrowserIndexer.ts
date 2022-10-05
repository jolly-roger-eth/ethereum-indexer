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

	async indexMore(): Promise<LastSync> {
		if (!this.indexer) {
			await this.setupIndexing();
		}
		const lastSync = await this.indexer.indexMore();
		this.store.set(lastSync);
		return lastSync;
	}

	async indexToLatest(): Promise<LastSync> {
		if (!this.indexer) {
			await this.setupIndexing();
		}
		namedLogger.info(`indexing...`);
		let lastSync = await this.indexer.indexMore();
		this.store.set(lastSync);
		// const latestBlock = await this.eip1193Provider.request({method: 'eth_blockNumber', params:[]});
		while (lastSync.lastToBlock !== lastSync.latestBlock) {
			namedLogger.info(`indexing...`);
			lastSync = await this.indexer.indexMore();
			this.store.set(lastSync);
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
			this.indexingTimeout = setTimeout(this._auto_index.bind(this), 1000);
			return;
		}
	}
}
