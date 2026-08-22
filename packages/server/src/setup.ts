import type {MiddlewareHandler} from 'hono/types';
import type {ServerOptions} from './types.js';
import type {Env} from './env.js';
import type {RemoteSQL} from 'remote-sql';

export type SetupOptions<CustomEnv extends Env> = {
	serverOptions: ServerOptions<CustomEnv>;
};

export type Config<CustomEnv extends Env> = {
	db: RemoteSQL;
	env: CustomEnv;
};

declare module 'hono' {
	interface ContextVariableMap {
		config: Config<Env>; // no generics possible here, which is fine: server code only ever needs Env
	}
}

/**
 * Resolves the injected database and environment once per request and puts them
 * on the context.
 *
 * The injection is per-REQUEST rather than per-app because that is what the
 * Workers model requires: on Cloudflare the D1 binding arrives on the request's
 * `env`, and there is no app-construction moment at which it exists. Node could
 * bind once at startup, so this costs Node a trivial closure call in exchange
 * for one server that runs unmodified on both.
 */
export function setup<CustomEnv extends Env>(options: SetupOptions<CustomEnv>): MiddlewareHandler {
	const {getDB, getEnv} = options.serverOptions;

	return async (c, next) => {
		c.set('config', {
			db: getDB(c as never),
			env: getEnv(c as never),
		});
		return next();
	};
}
