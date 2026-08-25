import type {LogIngestion} from '@etherfold/core';
import type {Context} from 'hono';
import type {Bindings} from 'hono/types';
import type {RemoteSQL} from 'remote-sql';

export type ServerOptions<Env extends Bindings = Bindings> = {
	getDB: (c: Context<{Bindings: Env}>) => RemoteSQL;
	getEnv: (c: Context<{Bindings: Env}>) => Env;
	/**
	 * The stream-builder this deployment hosts, if it hosts one.
	 *
	 * Injected exactly like the database, and for the same reason: WHICH processor
	 * runs, against WHICH source, is a deployment's choice, and a server package
	 * that constructed one would have to know how to load a processor module,
	 * which is the CLI's job and not an HTTP app's. The resolved `{db, env}` is on
	 * the context by the time this is called (`c.get('config')`), so a host can
	 * build its processor from the same database the rest of the app uses.
	 *
	 * OPTIONAL, because an indexer-server is useful before it ingests anything:
	 * `/status` and `/admin/setup` answer on a server with no processor at all,
	 * and every existing host builds one that way. When it is absent the ingestion
	 * routes answer `501`, which says "this server does not do that" rather than
	 * pretending the route is missing.
	 */
	getIngestion?: (c: Context<{Bindings: Env}>) => LogIngestion | undefined;
};
