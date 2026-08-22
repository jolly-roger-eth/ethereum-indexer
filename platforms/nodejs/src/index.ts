import {serve} from '@hono/node-server';
import {createClient} from '@libsql/client';
import {RemoteLibSQL} from 'remote-sql-libsql';
import type {RemoteSQL} from 'remote-sql';
import {createServer, applySchema, readSchemaState, type Env} from '@etherfold/server';
import {logs} from 'named-logs';

const logger = logs('@etherfold/platform-nodejs');

export type NodeEnv = Env & {
	/** libSQL URL. A path like `file:./data/etherfold.db`, or `:memory:`. */
	DB: string;
	/** Port to listen on, when not passed explicitly. */
	PORT?: string;
};

export type StartOptions = {
	/** libSQL URL. Defaults to `DB` in the environment, else `file:./etherfold.db`. */
	db?: string;
	port?: number;
	hostname?: string;
	/**
	 * Apply the fixed-table schema at startup if it is not already there.
	 *
	 * On by default, because the Node host is the single-operator case: there is
	 * one process, it owns its database file, and making a user POST to an admin
	 * route before the server is usable is ceremony with no safety payoff. The
	 * multi-instance case (Workers) deliberately does NOT get this, since several
	 * instances racing to migrate one database is a different problem.
	 */
	autoSetup?: boolean;
	env?: Partial<NodeEnv>;
};

export type RunningServer = {
	port: number;
	url: string;
	db: RemoteSQL;
	close: () => Promise<void>;
};

/** Build the RemoteSQL a Node host uses. Exposed so tests and the CLI can share it. */
export function createNodeDB(url: string): RemoteSQL {
	return new RemoteLibSQL(createClient({url}));
}

/**
 * Start the indexer-server on Node.
 *
 * This is the whole adapter: it decides what `getDB` and `getEnv` return and
 * hands them to the platform-agnostic app. No route, no chain logic and no
 * storage decision lives here.
 */
export async function startServer(options: StartOptions = {}): Promise<RunningServer> {
	const processEnv = process.env as Partial<NodeEnv>;
	const env = {...processEnv, ...options.env} as NodeEnv;
	const dbURL = options.db ?? env.DB ?? 'file:./etherfold.db';
	const port = options.port ?? (env.PORT ? Number(env.PORT) : 2000);
	const hostname = options.hostname;

	const db = createNodeDB(dbURL);

	if (options.autoSetup !== false) {
		const state = await readSchemaState(db);
		if (!state.applied) {
			logger.info(`applying fixed-table schema to ${dbURL}`);
			await applySchema(db);
		}
	}

	const app = createServer<NodeEnv>({getDB: () => db, getEnv: () => env});

	const server = serve({fetch: app.fetch, port, hostname});

	// port 0 means "any free port", and the caller cannot know which one it got
	// unless we read it back off the listening socket
	const address = server.address();
	const boundPort = typeof address === 'object' && address ? address.port : port;

	return {
		port: boundPort,
		url: `http://${hostname ?? 'localhost'}:${boundPort}`,
		db,
		close: () => new Promise<void>((resolve, reject) => server.close((err?: Error) => (err ? reject(err) : resolve()))),
	};
}
