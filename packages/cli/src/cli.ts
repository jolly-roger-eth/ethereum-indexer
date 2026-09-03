#! /usr/bin/env node
import {loadEnv} from 'ldenv';
loadEnv();

import {createProgram} from './program.js';

// `parseAsync`, and a catch, because a command's handler may be async and a
// CONFIGURATION REFUSAL is the most likely thing it rejects with. Those messages
// are written to be read -- they name the flag, the variable and the command that
// does own the input -- so they are printed as the message they are rather than
// as an unhandled rejection with a stack trace through the resolver. The exit
// code is 1, which is what `build` already resolves for a failure.
createProgram()
	.parseAsync(process.argv)
	.catch((err: unknown) => {
		console.error(err instanceof Error ? err.message : err);
		process.exit(1);
	});
