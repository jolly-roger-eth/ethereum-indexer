import type {Context} from 'hono';
import type {Bindings} from 'hono/types';
import type {RemoteSQL} from 'remote-sql';

export type ServerOptions<Env extends Bindings = Bindings> = {
	getDB: (c: Context<{Bindings: Env}>) => RemoteSQL;
	getEnv: (c: Context<{Bindings: Env}>) => Env;
};
