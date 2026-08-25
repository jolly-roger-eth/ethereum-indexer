/**
 * How many times to try again, how long to wait between, and how to wait.
 *
 * `wait` is injectable for one reason that is not testing convenience: this
 * package names no host (ADR-0003 and the `platforms/*` split), so the delay has
 * to be expressible without a scheduler. The default uses the `setTimeout` every
 * runtime has; a Worker that wants its own, and a test that wants none, pass one.
 */
export type RetryPolicy = {
	/** Total attempts INCLUDING the first, so `1` means "do not retry". Default 4. */
	attempts?: number;
	/** Delay before the second attempt, in milliseconds. Default 500. */
	initialDelayMs?: number;
	/** Multiplier applied to the delay after each failure. Default 2. */
	factor?: number;
	/** Ceiling for the delay, in milliseconds. Default 10000. */
	maxDelayMs?: number;
	wait?: (ms: number) => Promise<void>;
};

export type ResolvedRetryPolicy = Required<RetryPolicy>;

export function resolveRetryPolicy(policy: RetryPolicy = {}): ResolvedRetryPolicy {
	return {
		attempts: policy.attempts ?? 4,
		initialDelayMs: policy.initialDelayMs ?? 500,
		factor: policy.factor ?? 2,
		maxDelayMs: policy.maxDelayMs ?? 10_000,
		wait: policy.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
	};
}

/**
 * Run an operation, retrying only the failures that CAN succeed later.
 *
 * The predicate is the point. A bounded retry loop over everything turns a
 * misconfiguration into an infinite polite request, and the whole reason the
 * wire has two refusal codes is so that a sender can tell the difference (ADR-0004):
 * one is resumable, the other never will be. So the caller says which is which,
 * and a non-retryable failure leaves on the first attempt with its own type
 * intact, unwrapped, for whoever is watching.
 */
export async function withRetries<T>(
	operation: () => Promise<T>,
	options: {
		policy: ResolvedRetryPolicy;
		retryable: (error: unknown) => boolean;
		/** What is being attempted, for the log line. Must never contain a credential. */
		what: string;
		onRetry?: (info: {error: unknown; attempt: number; delayMs: number; what: string}) => void;
	},
): Promise<T> {
	const {policy, retryable, what} = options;
	let delayMs = policy.initialDelayMs;
	for (let attempt = 1; ; attempt++) {
		try {
			return await operation();
		} catch (err) {
			if (attempt >= policy.attempts || !retryable(err)) {
				throw err;
			}
			options.onRetry?.({error: err, attempt, delayMs, what});
			await policy.wait(delayMs);
			delayMs = Math.min(delayMs * policy.factor, policy.maxDelayMs);
		}
	}
}
