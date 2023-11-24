#! /usr/bin/env node
import {loadEnv} from 'ldenv';
loadEnv();

import {Command} from 'commander';
import pkg from '../package.json';
import {run} from '.';
import type {Options} from './types';

const program = new Command();

program
	.name('ei')
	.version(pkg.version)
	.usage(`ei -p <processor's path> [-d <deployment folder> -n http://localhost:8545]`)
	.description('Run The Indexer as Server')
	.requiredOption(
		'-p, --processor <path>',
		`path to the event processor module (need to export a field named "createProcessor")`
	)
	.requiredOption('-f, --file <value>', 'file to start from')
	.option(
		'-d, --deployments <value>',
		"path the folder containing contract deployments, use hardhat-deploy format, optional if processor's module provide it"
	)
	.option(
		'--rps <value>',
		"request per seconds"
	);

if (process.env.ETHEREUM_NODE) {
	program.option(
		'-n, --node-url <value>',
		`ethereum's node url (fallback on ETHEREUM_NODE env variable)`,
		process.env.ETHEREUM_NODE
	);
} else {
	program.requiredOption('-n, --node-url <value>', `ethereum's node url (fallback on ETHEREUM_NODE env variable)`);
}

program.parse(process.argv);

const options: Options = program.opts();

run(options).then(() => {
	console.log('DONE');
});
