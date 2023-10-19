import 'named-logs-console';

import Koa from 'koa';
import Router from 'koa-router';
import crypto from 'crypto';

import logger from 'koa-logger';
import json from 'koa-json';
import bodyParser from 'koa-bodyparser';

import {IndexingSource, Abi} from 'ethereum-indexer';

import {logs} from 'named-logs';

import {adminPage} from '../pages';
import {removeUndefinedValuesFromObject} from 'ethereum-indexer-utils';

const namedLogger = logs('ethereum-index-streams');

export type UserConfig = {
	folder: string;
	disableSecurity?: boolean;
	port?: number;
};

type Config = {
	folder: string;
	disableSecurity: boolean;
	port: number;
};

export class MultiStreamServer {
	protected app: Koa | undefined;
	protected config: Config;
	protected indexing: boolean = false;
	protected indexingTimeout: NodeJS.Timeout | undefined;
	protected sources: IndexingSource<Abi>[] = [];

	constructor(config: UserConfig) {
		this.config = Object.assign(
			{useCache: false, disableSecurity: false, useFSCache: false, port: 14385},
			removeUndefinedValuesFromObject(config)
		);
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
		// TODO for each source
		// get all current source
	}

	private startIndexing(): boolean {
		// if (!this.indexing) {
		// 	this.index();
		// 	return true;
		// } else {
		// 	return false;
		// }

		return false;
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

		function isAuthorized(ctx: any): boolean {
			if (self.config.disableSecurity) {
				return true;
			}
			// TODO pass api key in get request ?
			const apiKeyProvided = ctx.request.header.authorization || ctx.request.body.apiKey;
			return apiKeys.includes(apiKeyProvided);
		}

		// router.get('/', async (ctx, next) => {
		// 	if (!this.indexer) {
		// 		throw new Error(`no indexer`);
		// 	}
		// 	if (!this.lastSync) {
		// 		throw new Error(`no lastSync`);
		// 	}

		// 	const startingBlock = this.indexer.defaultFromBlock;
		// 	const latestBlock = this.lastSync.latestBlock;
		// 	const lastToBlock = this.lastSync.lastToBlock;

		// 	const totalToProcess = latestBlock - startingBlock;
		// 	const numBlocksProcessedSoFar = Math.max(0, lastToBlock - startingBlock);

		// 	const lastSyncObject = formatLastSync(this.lastSync);
		// 	lastSyncObject.numBlocksProcessedSoFar = numBlocksProcessedSoFar;
		// 	lastSyncObject.syncPercentage = Math.floor((numBlocksProcessedSoFar * 1000000) / totalToProcess) / 10000;
		// 	lastSyncObject.totalPercentage = Math.floor((lastToBlock * 1000000) / latestBlock) / 10000;

		// 	// allow to get state whole
		// 	const data = (this.processor as any).json;
		// 	if (data) {
		// 		const _data = (this.processor as any)._json;
		// 		if (_data) {
		// 			ctx.body = bnReplacer({lastSync: lastSyncObject, indexing: this.indexing, data, _data});
		// 		} else {
		// 			ctx.body = bnReplacer({lastSync: lastSyncObject, indexing: this.indexing, data});
		// 		}
		// 	} else {
		// 		const _data = (this.processor as any)._json;
		// 		if (_data) {
		// 			ctx.body = bnReplacer({lastSync: lastSyncObject, indexing: this.indexing, _data});
		// 		} else {
		// 			ctx.body = bnReplacer({lastSync: lastSyncObject, indexing: this.indexing});
		// 		}
		// 	}

		// 	await next();
		// });

		// // TODO what about kind ?
		// // feel like we shold consider it first class citizen
		// // get is always a kind plus an id
		// // multiple kinds is separate stuff
		// router.get('/get/:id', async (ctx, next) => {
		// 	if (!this.processor) {
		// 		throw new Error(`no processor`);
		// 	}

		// 	const documentID = ctx.params['id'];
		// 	const response = await this.processor.get(documentID);
		// 	if (response) {
		// 		ctx.body = bnReplacer(clean(response));
		// 	}

		// 	await next();
		// });

		// router.post('/query', async (ctx, next) => {
		// 	if (!this.processor) {
		// 		throw new Error(`no processor`);
		// 	}
		// 	const response = await this.processor.query(ctx.request.body as Query);
		// 	// TODO clean response ? or force fields to be specified and prevent some (like underscore)
		// 	ctx.body = bnReplacer(response);
		// 	await next();
		// });

		// ----------------------------------------------------------------------------------------------------------------
		// ADMIN ROUTES
		// ----------------------------------------------------------------------------------------------------------------

		router.get('/admin', async (ctx, next) => {
			ctx.body = adminPage;
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

		// router.post('/indexMore', async (ctx, next) => {
		// 	if (!this.indexer) {
		// 		throw new Error(`no indexer`);
		// 	}
		// 	if (!isAuthorized(ctx)) {
		// 		ctx.body = {error: {code: 4030, message: 'Forbidden'}};
		// 	} else {
		// 		if (this.indexing) {
		// 			ctx.body = {error: {code: 4040, message: 'Indexing Already'}};
		// 		} else {
		// 			this.lastSync = await this.indexer.indexMore();
		// 			ctx.body = {lastSync: this.lastSync};
		// 		}
		// 	}

		// 	await next();
		// });

		// router.post('/events', async (ctx, next) => {
		// 	if (!this.cache) {
		// 		throw new Error(`no cache`);
		// 	}
		// 	if (!isAuthorized(ctx)) {
		// 		ctx.body = {error: {code: 4030, message: 'Forbidden'}};
		// 	} else {
		// 		const response = await this.cache.query(ctx.request.body as Query);
		// 		ctx.body = response;
		// 	}
		// 	await next();
		// });

		// ----------------------------------------------------------------------------------------------------------------

		// Middlewares
		this.app.use(json());
		if (process.env.NAMED_LOGS && process.env.NAMED_LOGS_LEVEL && parseInt(process.env.NAMED_LOGS_LEVEL) >= 3) {
			this.app.use(logger());
		}

		this.app.use(bodyParser());

		this.app.use(router.routes()).use(router.allowedMethods());

		const port = this.config.port;
		this.app.listen(port, () => {
			console.log(`server started on port: ${port}`);
		});
	}

	// async index() {
	// 	if (!this.indexer) {
	// 		throw new Error(`no indexer`);
	// 	}
	// 	this.indexing = true;
	// 	try {
	// 		namedLogger.info('server indexing more...');
	// 		this.lastSync = await this.indexer.indexMore();
	// 	} catch (err) {
	// 		namedLogger.info('server error: ', err);
	// 		this.indexingTimeout = setTimeout(this.index.bind(this), 1000);
	// 		return;
	// 	}

	// 	if (this.lastSync.latestBlock - this.lastSync.lastToBlock < 1) {
	// 		namedLogger.info('no new block, skip');
	// 		this.indexingTimeout = setTimeout(this.index.bind(this), 1000);
	// 	} else {
	// 		this.indexingTimeout = setTimeout(this.index.bind(this), 1);
	// 	}
	// }
}
