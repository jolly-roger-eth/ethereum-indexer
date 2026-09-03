import type {Command} from 'commander';
import {describe, expect, it} from 'vitest';
import {createProgram, type ProgramDependencies} from '../src/program.js';
import type {Options} from '../src/types.js';

// ---------------------------------------------------------------------------------------------------
// THE COMMAND SURFACE: A WORD RESOLVES OR IT DOES NOT, AND NOTHING IS IMPLICIT
// ---------------------------------------------------------------------------------------------------
// The five names of `one-command-runs-the-whole-pipeline` are chosen so a reader
// can tell what a process will DO, which only holds if every word means one
// thing. So the two that ship are asserted at the surface a user types at:
// `build` is the one-shot (`CONTEXT.md`: follows the chain, folds, EXITS at the
// tip), `index` resolves to nothing at all because that word belongs to the wire
// receiver, and no command is commander's default -- a bare invocation prints
// help rather than silently meaning one of the five.
//
// What this file does NOT assert is requiredness. That lives in the resolver
// (`configuration.test.ts`), never in the parser, so nothing here is a
// `requiredOption` and nothing carries a commander default: a flag that is
// always present can never fall back to the variable behind it.
//
// The handlers are injected, so this file asserts the WORDS and the FLAGS
// without loading a processor module or binding a port.
// ---------------------------------------------------------------------------------------------------

/** Errors and help go to these arrays instead of the process, all the way down the command tree. */
function silence(command: Command, output: string[]): void {
	command.exitOverride();
	command.configureOutput({writeOut: (text) => output.push(text), writeErr: (text) => output.push(text)});
	for (const sub of command.commands) silence(sub, output);
}

function programUnderTest(deps: ProgramDependencies = {}) {
	const built: Options[] = [];
	const served: Options[] = [];
	const output: string[] = [];
	const program = createProgram({
		env: {},
		build: (options) => {
			built.push(options);
		},
		serve: async (options) => {
			served.push(options);
		},
		...deps,
	});
	silence(program, output);
	return {
		built,
		served,
		output,
		run: (argv: string[]) => program.parseAsync(argv, {from: 'user'}),
	};
}

describe('`build` is the one-shot', () => {
	it('resolves, and hands its handler every flag the one-shot has always taken', async () => {
		const cli = programUnderTest();

		await cli.run([
			'build',
			'-p',
			'./processor.js',
			'--store',
			'sqlite',
			'--db',
			'file:./etherfold.db',
			'--retention',
			'50000',
			'-d',
			'./deployments',
			'--rps',
			'5',
			'-n',
			'http://localhost:8545',
		]);

		expect(cli.built).toHaveLength(1);
		expect(cli.built[0]).toMatchObject({
			processor: './processor.js',
			nodeUrl: 'http://localhost:8545',
			store: 'sqlite',
			db: 'file:./etherfold.db',
			retention: '50000',
			deployments: './deployments',
			// commander hands every flag over as a string, and the type says so now: the
			// resolver is what turns it into a rate
			rps: '5',
		});
	});

	it('does not make -n a parser requirement, so the resolver can name ETH_NODE_URI behind it', async () => {
		const cli = programUnderTest();

		// the parser accepts it; what refuses is `resolveCommandConfig`, which is what
		// lets the refusal name the variable as well as the flag
		await cli.run(['build', '-p', './processor.js', '--store', 'sqlite', '--db', ':memory:']);
		expect(cli.built).toHaveLength(1);
		expect(cli.built[0]!.nodeUrl).toBeUndefined();
	});
});

describe('`index` is not the one-shot any more', () => {
	it('resolves to nothing, so the word is free for the wire receiver', async () => {
		const cli = programUnderTest();

		await expect(
			cli.run([
				'index',
				'-p',
				'./processor.js',
				'--store',
				'sqlite',
				'--db',
				':memory:',
				'-n',
				'http://localhost:8545',
			]),
		).rejects.toThrow(/unknown command/i);
		expect(cli.built).toEqual([]);
	});
});

describe('no command is implicit', () => {
	it('prints help on a bare invocation instead of running one of them', async () => {
		const cli = programUnderTest();

		await expect(cli.run([])).rejects.toMatchObject({code: 'commander.help'});
		expect(cli.built).toEqual([]);
		expect(cli.served).toEqual([]);
		expect(cli.output.join('')).toMatch(/Commands:[\s\S]*build[\s\S]*serve/);
	});

	it('refuses the old default-command form rather than folding under no name', async () => {
		const cli = programUnderTest();

		await expect(
			cli.run(['-p', './processor.js', '--store', 'sqlite', '--db', ':memory:', '-n', 'http://localhost:8545']),
		).rejects.toThrow(/unknown option/i);
		expect(cli.built).toEqual([]);
	});
});

describe('`serve` is still `serve`', () => {
	it('resolves, and hands its handler the flags the read tier owns', async () => {
		const cli = programUnderTest();

		await cli.run(['serve', '--db', 'file:./etherfold.db']);
		expect(cli.served[0]).toMatchObject({db: 'file:./etherfold.db', autoSetup: true});
		// NOT defaulted by the parser: a commander default is always present, so it
		// would make PORT unreachable. 2000 is the resolver's, and only when neither
		// the flag nor the variable said anything
		expect(cli.served[0]!.port).toBeUndefined();

		await cli.run(['serve', '--db', 'file:./etherfold.db', '--port', '3000', '--no-auto-setup']);
		expect(cli.served[1]).toMatchObject({port: '3000', autoSetup: false});
	});
});

// ---------------------------------------------------------------------------------------------------
// A COMMAND LINE COPIED ACROSS GETS TOLD WHAT TO CHANGE
// ---------------------------------------------------------------------------------------------------
// A flag a command does not own PARSES, so it reaches the resolver and is refused
// with the reason -- rather than meeting commander's `unknown option`, which
// names neither a reason nor the command that does own it. That is the whole
// point of "moving between commands is a deployment change, never a rewrite":
// the flags that do not move say where they went.
// ---------------------------------------------------------------------------------------------------

describe('flags a command does not own reach the resolver, and are refused there', () => {
	it('parses -p on `serve` rather than calling it an unknown option', async () => {
		const cli = programUnderTest();

		await cli.run(['serve', '--db', ':memory:', '-p', './processor.js']);
		expect(cli.served[0]).toMatchObject({processor: './processor.js'});
	});

	it('keeps them out of --help, so the surface a user reads is what the command owns', async () => {
		const cli = programUnderTest();

		await expect(cli.run(['serve', '--help'])).rejects.toMatchObject({code: 'commander.helpDisplayed'});
		const help = cli.output.join('');
		expect(help).toMatch(/--db/);
		expect(help).toMatch(/--port/);
		expect(help).not.toMatch(/--processor/);
		expect(help).not.toMatch(/--ingest-token/);
	});

	it('shows every flag `build` owns, and no flag it does not', async () => {
		const cli = programUnderTest();

		await expect(cli.run(['build', '--help'])).rejects.toMatchObject({code: 'commander.helpDisplayed'});
		const help = cli.output.join('');
		for (const owned of ['--processor', '--deployments', '--node-url', '--rps', '--store', '--db', '--retention']) {
			expect(help).toMatch(owned);
		}
		for (const notOwned of ['--port', '--host', '--ingest-endpoint', '--ingest-token']) {
			expect(help).not.toMatch(notOwned);
		}
	});

	it('names the variable behind a flag in the help text, so both are in one place', async () => {
		const cli = programUnderTest();

		await expect(cli.run(['build', '--help'])).rejects.toMatchObject({code: 'commander.helpDisplayed'});
		const help = cli.output.join('');
		expect(help).toMatch(/ETH_NODE_URI/);
		expect(help).toMatch(/\bDB\b/);
		expect(help).toMatch(/INDEXING_SOURCE/);
		expect(help).not.toMatch(/ETHEREUM_NODE/);
	});
});
