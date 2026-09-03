import type {Command} from 'commander';
import {describe, expect, it} from 'vitest';
import {createProgram, type ProgramDependencies, type ServeOptions} from '../src/program.js';
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
// The handlers are injected, so this file asserts the WORDS and the FLAGS
// without loading a processor module or binding a port. What each command then
// does with those flags is asserted by `indexOptions`, `oneShot` and `refusals`.
// ---------------------------------------------------------------------------------------------------

/** Errors and help go to these arrays instead of the process, all the way down the command tree. */
function silence(command: Command, output: string[]): void {
	command.exitOverride();
	command.configureOutput({writeOut: (text) => output.push(text), writeErr: (text) => output.push(text)});
	for (const sub of command.commands) silence(sub, output);
}

function programUnderTest(deps: ProgramDependencies = {}) {
	const built: Options[] = [];
	const served: ServeOptions[] = [];
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
		});
		// commander hands every flag over as a string; that `--rps` is TYPED as a
		// number is a lie older than this rename and not this task's to correct
		expect(String(cli.built[0]!.rps)).toBe('5');
	});

	it('keeps -n required, and keeps ETHEREUM_NODE as its fallback', async () => {
		const bare = programUnderTest({env: {}});
		await expect(bare.run(['build', '-p', './processor.js', '--store', 'sqlite', '--db', ':memory:'])).rejects.toThrow(
			/--node-url/,
		);
		expect(bare.built).toEqual([]);

		const fromEnv = programUnderTest({env: {ETHEREUM_NODE: 'http://node.from.env'}});
		await fromEnv.run(['build', '-p', './processor.js', '--store', 'sqlite', '--db', ':memory:']);
		expect(fromEnv.built[0]!.nodeUrl).toBe('http://node.from.env');
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
	it('resolves, defaults its port, and applies the schema unless told not to', async () => {
		const cli = programUnderTest();

		await cli.run(['serve', '--db', 'file:./etherfold.db']);
		expect(cli.served[0]).toMatchObject({port: '2000', db: 'file:./etherfold.db', autoSetup: true});

		await cli.run(['serve', '--db', 'file:./etherfold.db', '--port', '3000', '--no-auto-setup']);
		expect(cli.served[1]).toMatchObject({port: '3000', autoSetup: false});
	});

	it('takes no processor, because it hosts none', async () => {
		const cli = programUnderTest();

		await expect(cli.run(['serve', '-p', './processor.js'])).rejects.toThrow(/unknown option/i);
		expect(cli.served).toEqual([]);
	});
});
