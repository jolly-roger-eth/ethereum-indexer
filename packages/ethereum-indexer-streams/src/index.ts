#! /usr/bin/env node
import {loadEnv} from 'ldenv';
loadEnv();

import {runServer} from './server';
import {Command} from 'commander';
import pkg from '../package.json';

const program = new Command();

program.name('ei-streams').version(pkg.version).usage(`ei-streams`).description('Run Streams');

program
	.option('-f, --folder <value>', 'where to save the database data')
	.option('--wait', "server start but indexing wait a POST request to '/start")
	.option('--disable-security', 'ALLOW ANYONE TO CALL ADMIN FUNCTIONS')
	// .option('--use-fs-cache', 'use fs cache to store event stream')
	.option('--port <value>', 'port number to attach the server on')
	.parse(process.argv);

const options = program.opts();

runServer(options as any);
