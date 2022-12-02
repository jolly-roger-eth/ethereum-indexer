import 'dotenv/config';

import 'named-logs-console';

import Koa from 'koa';
import Router from 'koa-router';
import crypto from 'crypto';

import logger from 'koa-logger';
import json from 'koa-json';
import bodyParser from 'koa-bodyparser';

import {ContractsInfo, EthereumIndexer, EventProcessor, LastSync} from 'ethereum-indexer';
import {JSONRPCProvider} from 'ethereum-indexer-utils';
import {ProcessorFilesystemCache} from 'ethereum-indexer-fs-cache';

import {logs} from 'named-logs';

// TODO We should move EventCache, PouchDatabase and QueriableEventProcessor in a separate low-level module so server does not need to import 'ethereum-indexer-db-processors';
import {EventCache, PouchDatabase, QueriableEventProcessor, Query} from 'ethereum-indexer-db-processors';
import {adminPage} from '../pages';

const namedLogger = logs('ethereum-index-server');

function bnReplacer(v: any): any {
	if (typeof v === 'bigint') {
		return v.toString() + 'n';
	} else {
		if (typeof v === 'object') {
			if (Array.isArray(v)) {
				return v.map((v) => bnReplacer(v));
			} else {
				const keys = Object.keys(v);
				const n = {};
				for (const key of keys) {
					n[key] = bnReplacer(v[key]);
				}
				return n;
			}
		} else {
			return v;
		}
	}
}

export type UserConfig = {
	nodeURL: string;
	folder: string;
	processorPath: string;
	contractsData?: ContractsInfo;
	useCache?: boolean;
	disableSecurity?: boolean;
	useFSCache?: boolean;
};

type Config = {
	nodeURL: string;
	folder: string;
	processorPath: string;
	useCache: boolean;
	disableSecurity: boolean;
	useFSCache: boolean;
};

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

function formatLastSync(lastSync: LastSync): any {
	return filterOutFieldsFromObject(lastSync, ['_rev', '_id', 'batch']);
}

function filterOutUnderscoreFieldsFromObject<T = Object, U = Object>(obj: T): U {
	const keys = Object.keys(obj);
	const newObj: U = {} as U;
	for (const key of keys) {
		if (key.startsWith('_')) {
			continue;
		}
		newObj[key] = obj[key];
	}
	return newObj;
}

function clean(obj: Object) {
	return filterOutUnderscoreFieldsFromObject(obj);
}

export class SimpleServer {
	protected indexer: EthereumIndexer;
	protected app: Koa;
	protected lastSync: LastSync;
	protected config: Config;
	protected cache: EventCache;
	protected processor: QueriableEventProcessor;
	protected indexing: boolean = false;
	protected indexingTimeout: NodeJS.Timeout | undefined;

	protected contractsData: ContractsInfo;

	constructor(config: UserConfig) {
		this.config = Object.assign({useCache: false, disableSecurity: false, useFSCache: false}, config);
		this.contractsData = config.contractsData;
	}

	async start(config: {autoIndex: boolean}) {
		// TODO allow to pass processor configuration
		await this.setupIndexing();
		this.startServer();
		if (config.autoIndex) {
			this.startIndexing();
		}
	}

	private async setupIndexing() {
		const processorModule = await import(this.config.processorPath);
		const processorFactory = processorModule.processor as (config?: any) => QueriableEventProcessor;

		if (!processorFactory) {
			throw new Error(
				`processor field could not be found: check module at ${this.config.processorPath} if it exports a "processor" field`
			);
		}

		if (typeof processorFactory === 'function') {
			this.processor = processorFactory(this.config.folder);

			if (!this.processor) {
				throw new Error(
					`Processor could not be created, check the function exported as "processor" in module ${this.config.processorPath}`
				);
			}
		} else {
			this.processor = processorFactory;
		}

		const eip1193Provider = new JSONRPCProvider(this.config.nodeURL);

		if (!this.contractsData) {
			let chainIDAsDecimal: string | undefined;
			if (processorModule.contractsDataPerChain) {
				let chainIDAsHex;
				try {
					chainIDAsHex = await eip1193Provider.request<string>({method: 'eth_chainId', params: []});
				} catch (err) {
					console.error(`could not fetch chainID`);
					throw err;
				}
				chainIDAsDecimal = '' + parseInt(chainIDAsHex.slice(2), 16);
				namedLogger.info({chainIDAsHex, chainIDAsDecimal});
				this.contractsData = processorModule.contractsDataPerChain[chainIDAsDecimal];
			}
			if (!this.contractsData) {
				this.contractsData = processorModule.contractsData;
			}

			if (processorModule.contractsDataPerChain && !this.contractsData) {
				console.error(
					`field "contractsDataPerChain" found but no contracts data found for chainID: ${chainIDAsDecimal}`
				);
			}

			// if (!this.contractsData && processorModule.getContractData) {
			//   this.contractsData = await processorModule.getContractData();
			// }
		}

		if (!this.contractsData) {
			throw new Error(
				`contracts data not found in the processor module, it needs to be provided either as exported field named "contractsData" or as field "contractsDataPerChain" indexed by chainID`
			);
		}

		let rootProcessor: EventProcessor = this.processor;
		if (this.config.useCache) {
			const eventCacheDB = new PouchDatabase(`${this.config.folder}/event-stream.db`);
			this.cache = new EventCache(this.processor, eventCacheDB);
			rootProcessor = this.cache;
		}

		if (this.config.useFSCache) {
			rootProcessor = new ProcessorFilesystemCache(rootProcessor, this.config.folder);
		}

		this.indexer = new EthereumIndexer(eip1193Provider, rootProcessor, this.contractsData, {
			providerSupportsETHBatch: true,
		});

		namedLogger.info(`LOADING....`);
		this.lastSync = await this.indexer.load();
	}

	private startIndexing(): boolean {
		if (!this.indexing) {
			this.index();
			return true;
		} else {
			return false;
		}
	}

	private stopIndexing(): boolean {
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

	private async startServer() {
		const self = this;
		this.app = new Koa();
		const router = new Router();

		let apiKeys: string[];
		if (process.env.ETHEREUM_INDEXER_API_KEY) {
			apiKeys = process.env.ETHEREUM_INDEXER_API_KEY.split(',');
		} else {
			const apiKey = crypto.randomUUID();
			apiKeys = [apiKey];
			console.log(`generated apiKey: ${apiKey}`);
		}

		function isAuthorized(ctx): boolean {
			if (self.config.disableSecurity) {
				return true;
			}
			const apiKeyProvided = ctx.request.header.authorization || ctx.request.body.apiKey;
			return apiKeys.includes(apiKeyProvided);
		}

		router.get('/', async (ctx, next) => {
			const startingBlock = this.indexer.defaultFromBlock;
			const latestBlock = this.lastSync.latestBlock;
			const lastToBlock = this.lastSync.lastToBlock;

			const totalToProcess = latestBlock - startingBlock;
			const numBlocksProcessedSoFar = Math.max(0, lastToBlock - startingBlock);

			const lastSyncObject = formatLastSync(this.lastSync);
			lastSyncObject.numBlocksProcessedSoFar = numBlocksProcessedSoFar;
			lastSyncObject.syncPercentage = Math.floor((numBlocksProcessedSoFar * 1000000) / totalToProcess) / 10000;
			lastSyncObject.totalPercentage = Math.floor((lastToBlock * 1000000) / latestBlock) / 10000;

			// allow to get state whole
			const data = (this.processor as any).json;
			if (data) {
				const _data = (this.processor as any)._json;
				if (_data) {
					ctx.body = bnReplacer({lastSync: lastSyncObject, indexing: this.indexing, data, _data});
				} else {
					ctx.body = bnReplacer({lastSync: lastSyncObject, indexing: this.indexing, data});
				}
			} else {
				ctx.body = bnReplacer({lastSync: lastSyncObject, indexing: this.indexing});
			}

			await next();
		});

		// TODO what about kind ?
		// feel like we shold consider it first class citizen
		// get is always a kind plus an id
		// multiple kinds is separate stuff
		router.get('/get/:id', async (ctx, next) => {
			const documentID = ctx.params['id'];
			const response = await this.processor.get(documentID);
			ctx.body = bnReplacer(clean(response));
			await next();
		});

		router.post('/query', async (ctx, next) => {
			const response = await this.processor.query(ctx.request.body as Query);
			// TODO clean response ? or force fields to be specified and prevent some (like underscore)
			ctx.body = bnReplacer(response);
			await next();
		});

		// ----------------------------------------------------------------------------------------------------------------
		// ADMIN ROUTES
		// ----------------------------------------------------------------------------------------------------------------

		router.get('/admin', async (ctx, next) => {
			ctx.body = adminPage;
			await next();
		});

		router.post('/replay', async (ctx, next) => {
			if (!isAuthorized(ctx)) {
				ctx.body = {error: {code: 4030, message: 'Forbidden'}};
			} else if (!this.cache) {
				ctx.body = {error: {code: 223, message: 'Cache is disabled'}};
			} else {
				await this.cache.replay();
				ctx.body = {lastSync: this.lastSync};
			}
			await next();
		});

		router.post('/start', async (ctx, next) => {
			if (!isAuthorized(ctx)) {
				ctx.body = {error: {code: 4030, message: 'Forbidden'}};
			} else {
				ctx.body = {started: this.startIndexing()};
			}

			await next();
		});

		router.post('/stop', async (ctx, next) => {
			if (!isAuthorized(ctx)) {
				ctx.body = {error: {code: 4030, message: 'Forbidden'}};
			} else {
				ctx.body = {started: this.stopIndexing()};
			}

			await next();
		});

		router.post('/indexMore', async (ctx, next) => {
			if (!isAuthorized(ctx)) {
				ctx.body = {error: {code: 4030, message: 'Forbidden'}};
			} else {
				if (this.indexing) {
					ctx.body = {error: {code: 4040, message: 'Indexing Already'}};
				} else {
					this.lastSync = await this.indexer.indexMore();
					ctx.body = {lastSync: this.lastSync};
				}
			}

			await next();
		});

		router.post('/feed', async (ctx, next) => {
			if (!isAuthorized(ctx)) {
				ctx.body = {error: {code: 4030, message: 'Forbidden'}};
			} else if (this.indexing) {
				ctx.body = {error: {code: 222, message: 'Server is Indexing, cannot import.'}};
			} else {
				const eventStream = ctx.body.events;
				if (eventStream.length === 0) {
					ctx.body = {success: true};
				} else {
					await this.indexer.feed(eventStream);
				}
				ctx.body = {success: true};
			}
			await next();
		});

		router.post('/events', async (ctx, next) => {
			if (!isAuthorized(ctx)) {
				ctx.body = {error: {code: 4030, message: 'Forbidden'}};
			} else {
				const response = await this.cache.query(ctx.request.body as Query);
				ctx.body = response;
			}
			await next();
		});

		// ----------------------------------------------------------------------------------------------------------------

		// Middlewares
		this.app.use(json());
		if (process.env.NAMED_LOGS && process.env.NAMED_LOGS_LEVEL && parseInt(process.env.NAMED_LOGS_LEVEL) >= 3) {
			this.app.use(logger());
		}

		this.app.use(bodyParser());

		this.app.use(router.routes()).use(router.allowedMethods());

		const port = 14385;

		this.app.listen(port, () => {
			namedLogger.info(`server started on port: ${port}`);
		});
	}

	async index() {
		this.indexing = true;
		try {
			namedLogger.info('server indexing more...');
			this.lastSync = await this.indexer.indexMore();
		} catch (err) {
			namedLogger.info('server error: ', err);
			this.indexingTimeout = setTimeout(this.index.bind(this), 1000);
			return;
		}

		if (this.lastSync.latestBlock - this.lastSync.lastToBlock < 1) {
			namedLogger.info('no new block, skip');
			this.indexingTimeout = setTimeout(this.index.bind(this), 1000);
		} else {
			this.indexingTimeout = setTimeout(this.index.bind(this), 1);
		}
	}
}
