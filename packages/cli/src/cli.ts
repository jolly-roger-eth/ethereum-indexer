#! /usr/bin/env node
import {loadEnv} from 'ldenv';
loadEnv();

import {Command} from 'commander';
import pkg from '../package.json' with {type: 'json'};
import {main} from './index.js';
import type {Options} from './types.js';

const program = new Command();

program.name('etherfold').version(pkg.version).description('Index EVM logs into state, from a terminal');

/**
 * `index` is the DEFAULT command, so `etherfold -p x -f y` keeps working exactly
 * as it did when this binary was called `ei`. The rename already cost users the
 * command name (ADR-0017); it should not also cost them their argument order.
 */
const index = program
	.command('index', {isDefault: true})
	.description('run a processor over a source and write the resulting state to a libSQL database')
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

if (process.env.ETHEREUM_NODE) {
	index.option(
		'-n, --node-url <value>',
		`ethereum's node url (fallback on ETHEREUM_NODE env variable)`,
		process.env.ETHEREUM_NODE,
	);
} else {
	index.requiredOption('-n, --node-url <value>', `ethereum's node url (fallback on ETHEREUM_NODE env variable)`);
}

index.action((options: Options) => {
	// `main` resolves the exit code: 0 on success, 1 on failure (so CI does not treat a failed index as
	// success). It calls `process.exit`, which also avoids the process lingering on provider timers.
	main(options);
});

program
	.command('serve')
	.description('run the indexer-server over HTTP, backed by a local libSQL database')
	.option('--port <port>', 'port to listen on', '2000')
	.option('--db <url>', 'libSQL url, e.g. file:./etherfold.db or :memory:')
	.option('--host <hostname>', 'hostname to bind')
	.option('--no-auto-setup', 'do not apply the fixed-table schema at startup')
	.action(async (options: {port: string; db?: string; host?: string; autoSetup: boolean}) => {
		// Imported lazily so that `etherfold index` never pays for the server's
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
	});

program.parse(process.argv);
