import type {Abi} from '@etherfold/core';
import {
	createFetcherHost,
	resolveFetcherHostConfig,
	runFetcherLoop,
	type CycleReport,
	type EnvRecord,
	type FetcherHost,
	type FetcherHostConfigOverrides,
	type FetcherHostDependencies,
	type RunSummary,
} from '@etherfold/fetcher-host';
import {logs} from 'named-logs';

const logger = logs('@etherfold/platform-nodejs-fetcher');

/**
 * The Node host for the log-fetcher.
 *
 * A process that can hold a loop, so it holds one: cycles run back to back while
 * there is known work left, and back off to a poll interval once the chain has
 * been caught up. That is the entire platform-specific part, and the whole
 * reason the fetcher core was kept to "fetch this range and push it".
 *
 * What this file deliberately does NOT contain: fetching, reorg logic, and any
 * place to remember where it got to. Progress across restarts comes from the
 * receiver's cursor and from nothing else (ADR-0004), which is why there is no
 * state file, no lock file and no `--from-block`. Killing this process at any
 * moment loses nothing; the `409` on the next start is the recovery, and it
 * needs no operator.
 *
 * It is the only fetcher host in this repo, and that is a decision rather than an
 * omission. A serverless fetcher can only be triggered on a schedule (a
 * Cloudflare cron fires at most once a minute, and caps a sub-hour invocation at
 * about thirty seconds), so it cannot follow the tip the way this can; and a
 * deployment content with that cadence is better served by one cron-triggered
 * worker that fetches AND processes, which `createDirectIngestion`
 * (`@etherfold/core`) reduces to a target swap. `@etherfold/fetcher-host` carries
 * the invocation-shaped scheduler that worker needs.
 */

export type StartFetcherOptions<ABI extends Abi> = FetcherHostConfigOverrides<ABI> & {
	/** Defaults to `process.env`. Anything passed here is merged over it. */
	env?: EnvRecord;
	/**
	 * Stop the loop on SIGINT and SIGTERM. On by default, because that is what a
	 * container sends and a fetcher has nothing to flush: the cycle in flight is
	 * allowed to finish, and whatever it did or did not deliver is settled by the
	 * receiver's cursor next time.
	 */
	handleSignals?: boolean;
	/** Every cycle's report, in order. For metrics, or a host's own logging. */
	onReport?: (report: CycleReport) => void;
	/** Supply a provider, a transport or a `fetch`. Tests do; a deployment does not. */
	dependencies?: FetcherHostDependencies;
};

export type RunningFetcher<ABI extends Abi> = {
	host: FetcherHost<ABI>;
	/** Resolves when the loop has stopped, with what the run did. */
	stopped: Promise<RunSummary>;
	/** Ask the loop to stop after the cycle in flight, and wait for it. */
	stop: () => Promise<RunSummary>;
};

/**
 * Start the fetch loop.
 *
 * Returns as soon as the loop is running, like `startServer` in
 * `@etherfold/platform-nodejs` does: a caller gets a handle it can stop, and a
 * test gets one it can kill at an arbitrary moment.
 */
export function startFetcher<ABI extends Abi>(options: StartFetcherOptions<ABI> = {}): RunningFetcher<ABI> {
	const {env, handleSignals, onReport, dependencies, ...overrides} = options;
	const config = resolveFetcherHostConfig<ABI>({...(process.env as EnvRecord), ...env}, overrides);
	const host = createFetcherHost<ABI>(config, dependencies ?? {});

	const controller = new AbortController();
	const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
	const onSignal = (signal: NodeJS.Signals) => {
		logger.info(`${signal}: finishing the cycle in flight, then stopping. Nothing needs to be saved.`);
		controller.abort();
	};
	if (handleSignals !== false) {
		for (const signal of signals) {
			process.on(signal, onSignal);
		}
	}

	const stopped = runFetcherLoop(host, {signal: controller.signal, onReport}).then((summary) => {
		if (handleSignals !== false) {
			for (const signal of signals) {
				process.off(signal, onSignal);
			}
		}
		if (summary.stoppedBecause === 'fatal') {
			logger.error(
				`the fetch loop stopped after a refusal no retry can fix, having run ${summary.cycles} cycle(s). ` +
					`Fix the deployment and start it again; nothing was lost.`,
			);
		} else {
			logger.info(
				`the fetch loop stopped after ${summary.cycles} cycle(s), ${summary.pushed} of which pushed a batch.`,
			);
		}
		return summary;
	});

	return {
		host,
		stopped,
		stop: () => {
			controller.abort();
			return stopped;
		},
	};
}

/**
 * Run until stopped and resolve the process's exit code: `0` when it was asked
 * to stop, `1` when it stopped because nothing it could do would help.
 *
 * The distinction is the one the error carried all along. A bad `INGEST_TOKEN`,
 * a foreign `{source, config}` or a provider on the wrong chain must not leave a
 * container in a healthy-looking `Running`, because a fetcher that is up and
 * achieving nothing is indistinguishable from a working one until somebody reads
 * the state it is not producing.
 */
export async function runFetcherProcess<ABI extends Abi>(options: StartFetcherOptions<ABI> = {}): Promise<number> {
	try {
		const summary = await startFetcher<ABI>(options).stopped;
		return summary.stoppedBecause === 'fatal' ? 1 : 0;
	} catch (err) {
		// configuration that could not even build a host: a missing variable, an
		// unparseable source. Named, never quoted.
		logger.error(err instanceof Error ? err.message : String(err));
		return 1;
	}
}
