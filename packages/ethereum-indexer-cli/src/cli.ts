#! /usr/bin/env node
import {loadEnv} from 'ldenv';
loadEnv();

import {Command} from 'commander';
import pkg from '../package.json' with {type: 'json'};
import {main} from './index.js';
import type {Options} from './types.js';

const program = new Command();

program
	.name('ei')
	.version(pkg.version)
	.usage(`ei -p <processor's path> [-d <deployment folder> -n http://localhost:8545]`)
	.description('Run The Indexer And Write To File')
	.requiredOption(
		'-p, --processor <path>',
		`path to the event processor module (need to export a field named "createProcessor")`,
	)
	.requiredOption('-f, --folder <value>', 'folder to read and write to')
	.option(
		'-d, --deployments <value>',
		"path the folder containing contract deployments, use hardhat-deploy/rocketh format, optional if processor's module provide it",
	)
	.option('--rps <value>', 'request per seconds');

if (process.env.ETHEREUM_NODE) {
	program.option(
		'-n, --node-url <value>',
		`ethereum's node url (fallback on ETHEREUM_NODE env variable)`,
		process.env.ETHEREUM_NODE,
	);
} else {
	program.requiredOption('-n, --node-url <value>', `ethereum's node url (fallback on ETHEREUM_NODE env variable)`);
}

program.parse(process.argv);

const options: Options = program.opts();

// `main` resolves the exit code: 0 on success, 1 on failure (so CI does not treat a failed index as
// success). It calls `process.exit`, which also avoids the process lingering on provider timers.
main(options);
