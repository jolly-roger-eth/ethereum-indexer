#! /usr/bin/env node
import * as dotenv from 'dotenv';
import * as dotenvExpand from 'dotenv-expand';
// TODO if (mode)
const localEnv = dotenv.config({path: './.env.local'});
dotenvExpand.expand(localEnv);
const defaultEnv = dotenv.config({path: './.env'});
dotenvExpand.expand(defaultEnv);

import {runServer} from './server';
import {Command} from 'commander';
import pkg from '../package.json';
import figlet from 'figlet';
console.log(`------------------------------------------------`);
console.log(figlet.textSync('ethereum'));
console.log(figlet.textSync('     indexer'));
console.log(figlet.textSync('       server'));
console.log(`------------------------------------------------`);

const program = new Command();

// const example = `eis ../../etherplay/conquest-event-processor/dist/index.js -d ../../etherplay/conquest-eth/contracts/deployments/localhost -n http://localhost:8545`;

program
	.name('eis')
	.version(pkg.version)
	.description('Run The Indexer as Server')
	.requiredOption(
		'-p, --processor <path>',
		`path to the event processor module (need to export a field named "createProcessor")`
	)
	.option(
		'-d, --deployments <value>',
		"path the folder containing contract deployments, use hardhat-deploy format, optional if processor's module provide it"
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

program
	.option('-f, --folder <value>', 'where to save the database data')
	.option('--wait', "server start but indexing wait a POST request to '/start")
	.option(
		'--disable-cache',
		'disable caching (that caches the event strean so you can replay the event when processor changes instead of having to fetch them again. Note that chaging the contracts data will require a full reset)'
	)
	.option('--disable-security', 'ALLOW ANYONE TO CALL ADMIN FUNCTIONS')
	.option('--use-fs-cache', 'use fs cache to store event stream')
	.parse(process.argv);

const options = program.opts();

if (!options.nodeUrl) {
}

runServer(options.processor, options as any);
