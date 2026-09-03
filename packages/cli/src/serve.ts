import type {EnvRecord} from '@etherfold/fetcher-host';
import {resolveCommandConfig} from './config.js';
import type {Options, ServeConfig} from './types.js';

/** What a `startServer` call gives back, narrowed to what this command reads off it. */
export type StartedServer = {url: string; port: number};

export type ServeDependencies = {
	/** The environment flags fall back to. Defaults to `process.env`. */
	env?: EnvRecord;
	/** Starts the read tier. Defaults to the Node platform adapter's `startServer`, imported lazily. */
	startServer?: (options: {db: string; port: number; hostname?: string; autoSetup: boolean}) => Promise<StartedServer>;
	/** Where the two startup lines go. Defaults to the console. */
	log?: (...args: unknown[]) => void;
};

/**
 * `etherfold serve`: resolve the read tier's row of the table, then start it.
 *
 * ## Why the database is passed EXPLICITLY, always
 *
 * `platforms/nodejs` defaults its own database to `DB` in the environment and
 * then to `file:./etherfold.db`, which is the right shape for an adapter a
 * program embeds and the wrong one for a COMMAND: a `serve` that quietly created
 * an empty database file nobody named is a read tier answering, healthily, about
 * nothing. So the CLI resolves the database itself -- `--db` first, `DB` behind
 * it, a refusal naming both when neither is there -- and hands the answer over,
 * which is what keeps that convenience default unreachable from any command.
 */
export async function serve(options: Options, deps: ServeDependencies = {}): Promise<void> {
	const config: ServeConfig = resolveCommandConfig('serve', options, deps.env ?? (process.env as EnvRecord));
	const start = deps.startServer ?? defaultStartServer;
	const log = deps.log ?? console.log;

	const running = await start({
		db: config.destination.db,
		port: config.serving.port,
		...(config.serving.hostname === undefined ? {} : {hostname: config.serving.hostname}),
		autoSetup: config.serving.autoSetup,
	});
	log(`etherfold server listening on ${running.url}`);
	log(`  status: ${running.url}/status`);
}

async function defaultStartServer(options: {
	db: string;
	port: number;
	hostname?: string;
	autoSetup: boolean;
}): Promise<StartedServer> {
	// Imported lazily so that `etherfold build` never pays for the server's
	// dependency tree (hono, libSQL, the node HTTP adapter). The one-shot
	// indexing path is the common one and it should stay cheap to start.
	const {startServer} = await import('@etherfold/platform-nodejs');
	return startServer(options);
}
