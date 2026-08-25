import {Hono} from 'hono';
import {cors} from 'hono/cors';
import {hc} from 'hono/client';
import {HTTPException} from 'hono/http-exception';
import type {ServerOptions} from './types.js';
import type {Env} from './env.js';
import {getStatusAPI, recordError} from './api/status.js';
import {getIngestAPI} from './api/ingest.js';

export type {Env, ServerOptions};
export {SCHEMA_VERSION, applySchema, readSchemaState} from './schema.js';
export type {SchemaState} from './schema.js';
export type {Config} from './setup.js';
export {readReorgCounters, recordReorg} from './reorgs.js';
export type {ReorgCounters} from './reorgs.js';

const corsSetup = cors({
	origin: '*',
	allowHeaders: ['Content-Type', 'Upgrade-Insecure-Requests'],
	allowMethods: ['POST', 'GET', 'HEAD', 'OPTIONS'],
	exposeHeaders: ['Content-Length'],
	maxAge: 600,
	credentials: true,
});

/**
 * The indexer-server, minus any host.
 *
 * It knows `RemoteSQL` and nothing else: no Node built-ins, no Cloudflare types,
 * no D1. Everything host-shaped arrives through `getDB` / `getEnv`, which is what
 * lets `platforms/*` supply a libSQL file on Node and a D1 binding on Workers
 * without this package changing.
 */
export function createServer<CustomEnv extends Env>(options: ServerOptions<CustomEnv>) {
	const app = new Hono<{Bindings: CustomEnv}>();

	return app
		.use('/*', corsSetup)
		.route('/', getStatusAPI(options))
		.route('/', getIngestAPI(options))
		.onError((err, c) => {
			const env = c.get('config')?.env || {};
			recordError(err);

			if (err instanceof HTTPException && err.res) {
				return err.getResponse();
			}

			return c.json(
				{
					success: false,
					errors: [
						{
							name: 'name' in err ? err.name : undefined,
							code: 'code' in err ? (err as {code?: number}).code : 5000,
							message: err.message,
							cause: env.DEV ? err.cause : undefined,
							stack: env.DEV ? err.stack : undefined,
						},
					],
				},
				500,
			);
		});
}

export type App = ReturnType<typeof createServer>;

// computes the client type at compile time, as in the house template
const client = hc<App>('');
export type Client = typeof client;
export const createClient = (...args: Parameters<typeof hc>): Client => hc<App>(...args);
