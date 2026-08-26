import type {CycleReport} from './host.js';

/**
 * How long a host waits after each kind of cycle.
 *
 * Every number here is a scheduling decision, which is why it is in the host
 * layer and not in `@etherfold/core`: the fetcher reports what happened and says
 * nothing about when to come back.
 */
export type BackoffConfig = {
	/**
	 * After a cycle that reached the chain tip, and after `up-to-date`.
	 *
	 * The sensible value is around a block time: shorter mostly buys `up-to-date`
	 * answers, and each one still costs an `eth_chainId` and an `eth_blockNumber`.
	 */
	pollIntervalMs?: number;
	/**
	 * After a cycle that pushed but is still behind the tip. Zero on purpose: there
	 * is known work left, and a first sync is a long line of these.
	 */
	catchUpDelayMs?: number;
	/** The first delay after a retryable failure. Doubles per consecutive failure. */
	minRetryDelayMs?: number;
	/** The ceiling for the doubling, and the longest this host ever waits. */
	maxRetryDelayMs?: number;
	/**
	 * How much of a delay is given up to randomness, as a fraction (0 to 1).
	 *
	 * Not decoration: redundant fetchers are a design goal (ADR-0003), and two of
	 * them backing off in lockstep against one unreachable server retry in lockstep
	 * too. The delay lands in `[d * (1 - jitter), d]`.
	 */
	jitter?: number;
	/**
	 * How many consecutive `yielded` cycles before the host says so at WARN.
	 *
	 * One is ordinary -- it is what two fetchers do to each other, and it is not a
	 * failure. A RUN of them says the cursor is moving under every cycle this
	 * fetcher starts, which is worth a human's attention even though no single
	 * occurrence is.
	 */
	contentionRunAlert?: number;
	/** Injectable so a test can pin a delay exactly. Defaults to `Math.random`. */
	random?: () => number;
};

export type ResolvedBackoff = Required<BackoffConfig>;

export function resolveBackoff(config: BackoffConfig = {}): ResolvedBackoff {
	return {
		pollIntervalMs: config.pollIntervalMs ?? 4000,
		catchUpDelayMs: config.catchUpDelayMs ?? 0,
		minRetryDelayMs: config.minRetryDelayMs ?? 1000,
		maxRetryDelayMs: config.maxRetryDelayMs ?? 60000,
		jitter: config.jitter ?? 0.2,
		contentionRunAlert: config.contentionRunAlert ?? 3,
		random: config.random ?? Math.random,
	};
}

/** `base` doubled once per consecutive occurrence, capped, then jittered downwards. */
function escalate(base: number, run: number, config: ResolvedBackoff): number {
	const doubled = base * Math.pow(2, Math.max(0, run - 1));
	const capped = Math.min(doubled, config.maxRetryDelayMs);
	return Math.round(capped * (1 - config.jitter * config.random()));
}

/**
 * The delay a host should wait before the next cycle, given what the last one did.
 *
 * The classification it reads was made by `FetcherHost.runCycle` from the
 * error's own `retryable` flag; nothing here re-derives it from a status code or
 * a message. What this adds is only the WAIT:
 *
 * - `progress` and still behind -- no wait, there is known work left;
 * - `progress` up to the tip, or `idle` -- one poll interval. Neither is a
 *   failure: `up-to-date` means the chain has produced nothing above the cursor;
 * - `contended` (`yielded`) -- back off on an escalating curve, because the
 *   ordinary cause is another sender moving the cursor while we fetch, and the
 *   useful response to losing that race repeatedly is to stop racing;
 * - `retry` -- escalating from `minRetryDelayMs`. Core has already exhausted its
 *   own bounded retries by the time a host sees this;
 * - `fatal` -- the maximum, though a host normally stops instead of waiting.
 */
export function delayForReport(report: CycleReport, config: ResolvedBackoff): number {
	switch (report.kind) {
		case 'progress':
			return report.caughtUp ? config.pollIntervalMs : config.catchUpDelayMs;
		case 'idle':
			return config.pollIntervalMs;
		case 'contended':
			return escalate(config.pollIntervalMs, report.run, config);
		case 'retry':
			return escalate(config.minRetryDelayMs, report.run, config);
		case 'fatal':
			return config.maxRetryDelayMs;
	}
}
