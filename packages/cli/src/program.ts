import {Command} from 'commander';
import pkg from '../package.json' with {type: 'json'};
import {main} from './index.js';
import type {Options} from './types.js';

/** The flags `etherfold serve` takes, exactly as commander hands them over. */
export type ServeOptions = {port: string; db?: string; host?: string; autoSetup: boolean};

/**
 * What `cli.ts` supplies and a test substitutes.
 *
 * The handlers are injected for the same reason `main`'s are
 * (`src/index.ts`): the interesting part of this layer is WHICH WORDS resolve
 * and which flags they carry, and asserting that should not require loading a
 * processor module or binding a port.
 */
export type ProgramDependencies = {
	/** The environment flags fall back to. Defaults to `process.env`. */
	env?: Record<string, string | undefined>;
	/** Runs the one-shot. Defaults to `main`, which resolves the process exit code. */
	build?: (options: Options) => void;
	/** Starts the read tier. Defaults to the Node adapter's `startServer`. */
	serve?: (options: ServeOptions) => Promise<void>;
};

/**
 * The command surface: five names are coming, and each of them means one thing.
 *
 * `CONTEXT.md` ("The COMMAND SET names deployment intents, not components")
 * is the authority for the set. Two of the five ship: **`build`** follows the
 * chain, folds and EXITS at the tip, and **`serve`** answers queries over a
 * database written elsewhere. The other three (`run`, `fetch`, `index`) do not
 * exist yet, and the words are held free for them rather than borrowed.
 *
 * ## Why there is no DEFAULT command any more
 *
 * There was one, and the reason it existed has expired. `index` was registered
 * with `isDefault: true` so that `etherfold -p x -n y` kept working after the
 * binary stopped being called `ei` (ADR-0017 renamed it; the default was the
 * argument that the rename should not ALSO cost users their argument order).
 * The name is changing anyway here, nothing is published, and under a set of
 * names chosen so a reader can tell what a process will do, a bare invocation
 * that silently means one of the five is exactly the ambiguity the set exists
 * to remove. So a bare `etherfold` prints help and every run names its intent.
 */
export function createProgram(deps: ProgramDependencies = {}): Command {
	const env = deps.env ?? process.env;
	const runBuild =
		deps.build ??
		((options: Options) => {
			// `main` resolves the exit code: 0 on success, 1 on failure (so CI does not treat a failed
			// build as success). It calls `process.exit`, which also avoids the process lingering on
			// provider timers.
			main(options);
		});
	const runServe = deps.serve ?? defaultServe;

	const program = new Command();

	program.name('etherfold').version(pkg.version).description('Index EVM logs into state, from a terminal');

	const build = program
		.command('build')
		.description('follow the chain, fold a processor into a libSQL database, and exit at the tip')
		.usage(`-p <processor's path> --store sqlite --db <libsql url> [-d <deployment folder> -n http://localhost:8545]`)
		.requiredOption(
			'-p, --processor <path>',
			`path to the event processor module (need to export a field named "createProcessor")`,
		)
		/**
		 * REQUIRED, and never defaulted. It named two stores until the free-form state
		 * blob went with the processor path that wrote it (ADR-0037); it is kept as the
		 * axis a second backend arrives on. See `resolveIndexOptions`, which owns every
		 * refusal.
		 */
		.requiredOption(
			'--store <sqlite>',
			'where the indexed state goes: versioned entity rows in the libSQL database at --db',
		)
		.option('--db <url>', 'libSQL url, e.g. file:./etherfold.db or :memory: (required)')
		.option(
			'--retention <blocks|revert-only|unbounded>',
			'how far back superseded versions are kept, in BLOCK numbers. Nothing prunes ' +
				'automatically: pruning is a call a host schedules (ADR-0022)',
		)
		.option(
			'-d, --deployments <value>',
			"path the folder containing contract deployments, use hardhat-deploy/rocketh format, optional if processor's module provide it",
		)
		.option('--rps <value>', 'request per seconds');

	if (env.ETHEREUM_NODE) {
		build.option(
			'-n, --node-url <value>',
			`ethereum's node url (fallback on ETHEREUM_NODE env variable)`,
			env.ETHEREUM_NODE,
		);
	} else {
		build.requiredOption('-n, --node-url <value>', `ethereum's node url (fallback on ETHEREUM_NODE env variable)`);
	}

	build.action((options: Options) => {
		runBuild(options);
	});

	program
		.command('serve')
		.description('answer queries over a libSQL database written elsewhere: the read tier, which folds nothing')
		.option('--port <port>', 'port to listen on', '2000')
		.option('--db <url>', 'libSQL url, e.g. file:./etherfold.db or :memory:')
		.option('--host <hostname>', 'hostname to bind')
		.option('--no-auto-setup', 'do not apply the fixed-table schema at startup')
		.action(async (options: ServeOptions) => {
			await runServe(options);
		});

	return program;
}

async function defaultServe(options: ServeOptions): Promise<void> {
	// Imported lazily so that `etherfold build` never pays for the server's
	// dependency tree (hono, libSQL, the node HTTP adapter). The one-shot
	// indexing path is the common one and it should stay cheap to start.
	const {startServer} = await import('@etherfold/platform-nodejs');
	const running = await startServer({
		port: Number(options.port),
		db: options.db,
		hostname: options.host,
		autoSetup: options.autoSetup,
	});
	console.log(`etherfold server listening on ${running.url}`);
	console.log(`  status: ${running.url}/status`);
}
