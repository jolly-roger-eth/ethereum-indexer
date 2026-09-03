import {Command, Option} from 'commander';
import type {EnvRecord} from '@etherfold/fetcher-host';
import pkg from '../package.json' with {type: 'json'};
import {INPUTS, OWNERSHIP, type ConfigInput} from './config.js';
import {fetchMain} from './fetch.js';
import {main} from './index.js';
import {runMain} from './run.js';
import {serve} from './serve.js';
import type {CommandName, Options} from './types.js';

/**
 * What `cli.ts` supplies and a test substitutes.
 *
 * The handlers are injected for the same reason `main`'s are (`src/index.ts`):
 * the interesting part of this layer is WHICH WORDS resolve and which flags they
 * carry, and asserting that should not require loading a processor module or
 * binding a port.
 */
export type ProgramDependencies = {
	/** The environment flags fall back to. Defaults to `process.env`. */
	env?: EnvRecord;
	/** Runs the one-shot. Defaults to `main`, which resolves the process exit code. */
	build?: (options: Options) => void;
	/** Runs the follower. Defaults to `runMain`, which keeps going until a signal and resolves the exit code. */
	run?: (options: Options) => void | Promise<void>;
	/** Runs the chain-facing half. Defaults to `fetchMain`, which also hooks the log sink to the console. */
	fetch?: (options: Options) => void | Promise<void>;
	/** Starts the read tier. Defaults to `serve`, which resolves its database and starts the Node adapter. */
	serve?: (options: Options) => Promise<void>;
};

/**
 * Register every flag ONE command owns, and every flag it does not.
 *
 * Both halves come out of `OWNERSHIP` (`src/config.ts`), which is the single
 * table this command set's configuration is written in. What it owns is
 * registered visibly, with the description that table carries. What it does NOT
 * own is registered HIDDEN, so that a flag copied across from another command
 * parses, reaches the resolver, and is refused with the reason this command does
 * not own it -- instead of meeting commander's `unknown option`, which names
 * neither a reason nor the command that does own it. That is the whole payoff of
 * "moving between commands is a deployment change, never a rewrite": a copied
 * command line gets told what to change.
 *
 * Nothing is registered as `requiredOption` and nothing carries a commander
 * DEFAULT. Both would put a piece of the contract where no test can call it, and
 * a commander default is worse than that: a flag that is always present can never
 * fall back to the variable behind it, so `--port`'s old default silently made
 * `PORT` unreachable.
 */
function registerInputs(command: Command, name: CommandName): void {
	const row = OWNERSHIP[name];
	for (const input of Object.keys(INPUTS) as ConfigInput[]) {
		const spec = INPUTS[input];
		const described = spec.variable ? `${spec.describe} (or ${spec.variable})` : spec.describe;
		const option = new Option(spec.flag, described);
		if (row[input] === 'refused') option.hideHelp();
		command.addOption(option);
	}
}

/**
 * The command surface: five names are coming, and each of them means one thing.
 *
 * `CONTEXT.md` ("The COMMAND SET names deployment intents, not components")
 * is the authority for the set. Four of the five ship: **`run`** follows the
 * chain, folds AND answers queries without terminating -- the milestone, and the
 * default thing to reach for; **`build`** is the same assembly stopping at the
 * tip; **`serve`** answers queries over a database written elsewhere; and
 * **`fetch`** is the chain-facing half of a SPLIT deployment, which folds
 * nothing, holds no state and pushes to a receiver elsewhere -- the ONLY way to
 * run a fetcher, now that the standalone binary is retired. The one that does
 * not exist yet is `index`, the other half of that pair, and the word is held
 * free for it rather than borrowed -- but its configuration already resolves
 * (`OWNERSHIP` in `src/config.ts`), so adding it is a registration and an
 * assembly rather than a second way to read a flag.
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
	const env = deps.env ?? (process.env as EnvRecord);
	const runBuild =
		deps.build ??
		((options: Options) => {
			// `main` resolves the exit code: 0 on success, 1 on failure (so CI does not treat a failed
			// build as success). It calls `process.exit`, which also avoids the process lingering on
			// provider timers.
			main(options, {env});
		});
	const runServe = deps.serve ?? ((options: Options) => serve(options, {env}));
	const runFollower =
		deps.run ??
		((options: Options) => {
			// `runMain` resolves the exit code the same way `main` does, and for the same
			// reason: a follower that stopped on a refusal no waiting fixes must not look
			// like one that was asked to stop.
			return runMain(options, {env});
		});

	const program = new Command();

	program.name('etherfold').version(pkg.version).description('Index EVM logs into state, from a terminal');

	const run = program
		.command('run')
		.description('follow the chain, fold a processor into a libSQL database, and answer queries over it')
		.usage(`-p <processor's path> --store sqlite --db <libsql url> [--port 2000 -n http://localhost:8545]`);
	registerInputs(run, 'run');
	run.action(async (options: Options) => {
		await runFollower(options);
	});

	const build = program
		.command('build')
		.description('follow the chain, fold a processor into a libSQL database, and exit at the tip')
		.usage(`-p <processor's path> --store sqlite --db <libsql url> [-d <deployment folder> -n http://localhost:8545]`);
	registerInputs(build, 'build');
	build.action((options: Options) => {
		runBuild(options);
	});

	const runFetch =
		deps.fetch ??
		(async (options: Options) => {
			// Hooks the named-logs facade to the console. Done HERE, in the process entry
			// point, and never in the library: a fetcher's cycle logs are the only
			// observability a split deployment has, and the binary that used to hook it
			// (`etherfold-fetch`) is retired, so the CLI is that process now. An
			// application embedding `startFetcher` still chooses its own sink, and a
			// test substituting this handler installs none.
			await import('named-logs-console');
			// `fetchMain` resolves the exit code through the adapter's own
			// `runFetcherProcess`: non-zero when it stopped on a refusal, because a
			// fetcher that stays up while achieving nothing is indistinguishable from a
			// working one until somebody reads the state it is not producing.
			await fetchMain(options, {env});
		});

	const fetchCommand = program
		.command('fetch')
		.description(
			'follow the chain and push contiguous ranges of raw logs to an indexer-server elsewhere: ' +
				'the chain-facing half, which folds nothing and holds no state',
		)
		.usage('-n http://localhost:8545 -d <deployment folder> --ingest-endpoint http://indexer:2000');
	registerInputs(fetchCommand, 'fetch');
	fetchCommand.action(async (options: Options) => {
		await runFetch(options);
	});

	const serveCommand = program
		.command('serve')
		.description('answer queries over a libSQL database written elsewhere: the read tier, which folds nothing')
		.usage('--db <libsql url> [--port 2000]');
	registerInputs(serveCommand, 'serve');
	serveCommand.action(async (options: Options) => {
		await runServe(options);
	});

	return program;
}
