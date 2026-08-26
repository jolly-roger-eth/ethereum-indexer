import {IngestionUnavailableError} from '@etherfold/core';
import {describe, expect, it} from 'vitest';
import {createDirectIngestion} from '@etherfold/core';
import {
	createFetcherHost,
	FetcherConfigError,
	resolveFetcherHostConfig,
	runFetcherLoop,
	type CycleReport,
	type FetcherHost,
	type Sleep,
} from '../src/index.js';
import {
	ALICE,
	BRANCH_A,
	BRANCH_B,
	CAROL,
	deployReceiver,
	ENDPOINT,
	fakeChain,
	FINALITY,
	ownerOf,
	SOURCE,
	START_BLOCK,
	TOKEN,
	transferCount,
	type FakeChain,
	type Receiver,
	type TestABI,
} from './harness.js';

// ---------------------------------------------------------------------------
// THE TWO SCHEDULING SHAPES, AGAINST THE REAL RECEIVER
// ---------------------------------------------------------------------------
// A loop is what a host owning a process contributes; one bounded run is what a
// host given an invocation contributes. They are tested HERE, together, because
// the property worth protecting is that they AGREE: the difference between two
// hosts is meant to be when a cycle runs, and a test that drove each in its own
// file would let them drift and pass anyway. That matters more, not less, while
// the bounded shape has no adapter of its own in this repo (see `src/index.ts`):
// it is what keeps the shape honest until one wires it.
//
// Nothing is mocked between the halves. The receiver is the real Hono app over a
// real processor on a real libSQL database, reached through the real HTTP
// client; only the node is fake, and only so a reorg can be staged.
// ---------------------------------------------------------------------------

/** A sleep that returns at once but records what it was asked to wait, so a test can read the backoff. */
function instantSleep(): Sleep & {waits: number[]} {
	const waits: number[] = [];
	const fn = (async (ms: number) => {
		waits.push(ms);
	}) as Sleep & {waits: number[]};
	fn.waits = waits;
	return fn;
}

function hostFor(
	chain: FakeChain,
	receiver: Receiver,
	overrides: Parameters<typeof resolveFetcherHostConfig<TestABI>>[1] = {},
): FetcherHost<TestABI> {
	return createFetcherHost<TestABI>(
		resolveFetcherHostConfig<TestABI>(
			{},
			{
				source: SOURCE,
				endpoint: ENDPOINT,
				token: TOKEN,
				nodeUrl: 'http://node.test',
				stream: {finality: FINALITY},
				// no waiting inside a cycle either: what these tests are about is the wait
				// BETWEEN cycles, which is the host's
				retry: {attempts: 1},
				backoff: {pollIntervalMs: 10, catchUpDelayMs: 0, minRetryDelayMs: 5, jitter: 0, random: () => 0},
				...overrides,
			},
		),
		{provider: chain.provider, fetch: receiver.fetch},
	);
}

/** Stop the loop as soon as it has nothing left to do, which is what a test wants and a deployment does not. */
function stopWhenCaughtUp(controller: AbortController): (report: CycleReport) => void {
	return (report) => {
		if (report.kind === 'idle' || (report.kind === 'progress' && report.caughtUp)) {
			controller.abort();
		}
	};
}

// ---------------------------------------------------------------------------

describe('a loop follows the tip and backs off when there is nothing to do', () => {
	it('catches up without pausing, then settles into polling', async () => {
		const chain = fakeChain();
		const receiver = await deployReceiver();
		// a gap wider than one fetch covers, which is what a first sync is
		chain.serve(BRANCH_A, 400);
		const host = hostFor(chain, receiver);
		const controller = new AbortController();
		const waits = instantSleep();

		const summary = await runFetcherLoop(host, {
			signal: controller.signal,
			sleep: waits,
			onReport: stopWhenCaughtUp(controller),
		});

		expect(summary.stoppedBecause).toBe('stopped');
		expect(summary.cycles).toBeGreaterThan(1);
		expect(await transferCount(receiver)).toBe(3);
		// every cycle that was still behind waited for nothing, and the one that
		// reached the tip took a poll interval
		expect(waits.waits.slice(0, -1).every((wait) => wait === 0)).toBe(true);
		expect(waits.waits[waits.waits.length - 1]).toBe(10);
	});

	it('waits a poll interval when the chain has produced nothing above the cursor', async () => {
		const chain = fakeChain();
		const receiver = await deployReceiver();
		chain.serve(BRANCH_A, 120);
		const host = hostFor(chain, receiver);
		await host.runCycle();

		// The receiver's cursor is now 117 (120 - finality). Serving a LOWER tip is the
		// case the outcome is named for: this provider cannot see anything the receiver
		// does not already have, because another fetcher on a better-synced node got
		// there first. There is no range to send, and inventing one would mean claiming
		// a tip we did not observe.
		chain.serve(BRANCH_A, 116);
		const controller = new AbortController();
		const waits = instantSleep();
		let idle = 0;
		await runFetcherLoop(host, {
			signal: controller.signal,
			sleep: waits,
			onReport: (report) => {
				if (report.kind === 'idle' && ++idle === 2) {
					controller.abort();
				}
			},
		});

		expect(idle).toBe(2);
		// `up-to-date` is NOT a failure: it is polled, not escalated
		expect(waits.waits).toEqual([10, 10]);
	});

	it('escalates when the server is unreachable, and keeps going', async () => {
		const chain = fakeChain();
		const receiver = await deployReceiver();
		chain.serve(BRANCH_A, 110);
		let outages = 3;
		const host = createFetcherHost<TestABI>(
			resolveFetcherHostConfig<TestABI>(
				{},
				{
					source: SOURCE,
					endpoint: ENDPOINT,
					token: TOKEN,
					nodeUrl: 'http://node.test',
					stream: {finality: FINALITY},
					// core's own bounded retries turned off, so that each outage is one cycle and
					// the escalation being measured is this host's
					retry: {attempts: 1},
					backoff: {pollIntervalMs: 10, minRetryDelayMs: 5, jitter: 0, random: () => 0},
				},
			),
			{
				provider: chain.provider,
				fetch: async (url, init) => {
					if (outages-- > 0) {
						throw new Error('ECONNREFUSED');
					}
					return receiver.fetch(url, init);
				},
			},
		);

		const controller = new AbortController();
		const waits = instantSleep();
		const summary = await runFetcherLoop(host, {
			signal: controller.signal,
			sleep: waits,
			onReport: stopWhenCaughtUp(controller),
		});

		expect(summary.pushed).toBe(1);
		// three retryable cycles, each waiting twice as long as the last, then the push
		expect(waits.waits).toEqual([5, 10, 20, 10]);
		// block 116 is above this tip, so two of the three transfers are in range
		expect(await transferCount(receiver)).toBe(2);
	});

	it('stops on a refusal instead of retrying it forever', async () => {
		const chain = fakeChain();
		const receiver = await deployReceiver();
		chain.serve(BRANCH_A, 110);
		// the token the server does not have
		const host = hostFor(chain, receiver, {token: 'not-the-token'});
		const waits = instantSleep();

		const summary = await runFetcherLoop(host, {sleep: waits});

		expect(summary.stoppedBecause).toBe('fatal');
		expect(summary.cycles).toBe(1);
		expect(waits.waits).toEqual([]);
		expect((summary.error as {status: number}).status).toBe(401);
		// the message names the variable an operator must fix, and never its value
		expect((summary.error as Error).message).toMatch(/INGEST_TOKEN/);
		expect((summary.error as Error).message).not.toContain('not-the-token');
	});

	it('finishes the cycle in flight when it is asked to stop', async () => {
		const chain = fakeChain();
		const receiver = await deployReceiver();
		chain.serve(BRANCH_A, 110);
		const host = hostFor(chain, receiver);
		const controller = new AbortController();

		const release = chain.hangOnNextFetch();
		const running = runFetcherLoop(host, {signal: controller.signal, sleep: instantSleep()});
		controller.abort();
		release();
		const summary = await running;

		// the abort took effect at the top of the NEXT cycle, so the batch in flight
		// was not abandoned halfway
		expect(summary.cycles).toBe(1);
		expect(summary.stoppedBecause).toBe('stopped');
	});
});

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// THE PROPERTY THE WHOLE DESIGN EXISTS FOR
// ---------------------------------------------------------------------------

describe('a fetcher killed mid-run loses nothing', () => {
	it('is put back on track by the receiver, with no operator involved', async () => {
		const chain = fakeChain();
		const receiver = await deployReceiver();
		chain.serve(BRANCH_A, 110);

		// A host is killed INSIDE a cycle, between the fetch and the push. That is the
		// worst moment there is: the logs have been read and nothing has been
		// delivered, and a fetcher that had written a cursor before fetching would
		// come back believing work was done.
		const doomed = hostFor(chain, receiver);
		const release = chain.hangOnNextFetch();
		const abandoned = doomed.runCycle();
		// the process dies here. Nothing is awaited, nothing is closed.
		release();
		await abandoned.catch(() => undefined);

		// a NEW host, carrying nothing: no hint, no counters, nothing on disk
		const replacement = hostFor(chain, receiver);
		expect(replacement.fetcher.cursorHint).toBeUndefined();
		const controller = new AbortController();
		const summary = await runFetcherLoop(replacement, {
			signal: controller.signal,
			sleep: instantSleep(),
			onReport: stopWhenCaughtUp(controller),
		});

		expect(summary.lastReport?.kind).toBe('progress');
		// every log is applied exactly once, whatever the doomed host did or did not do
		expect(await transferCount(receiver)).toBe(2);
		expect(await ownerOf(receiver, '1')).toBe(ALICE);
	});

	it('is corrected by a 409 when a second fetcher moved the cursor under it', async () => {
		const chain = fakeChain();
		const receiver = await deployReceiver();
		chain.serve(BRANCH_A, 110);

		const first = hostFor(chain, receiver);
		await first.runCycle();

		// a second, redundant fetcher: allowed precisely because neither holds state
		chain.serve(BRANCH_A, 118);
		await hostFor(chain, receiver).runCycle();

		// the first host's hint is now stale, which is the restart case and the
		// lost-acknowledgement case in one
		const report = await first.runCycle();

		expect(report).toMatchObject({kind: 'progress', outcome: {corrections: 1}});
		expect(await transferCount(receiver)).toBe(3);
		const corrections = receiver.requests.filter((request) => request.status === 409);
		expect(corrections.length).toBe(1);
	});

	it('reports a run of yields as contention instead of as failures', async () => {
		const chain = fakeChain();
		const receiver = await deployReceiver();
		chain.serve(BRANCH_A, 110);
		// a cycle that follows no correction at all, so that being overtaken once is
		// enough to end it. The default is 2, and the point being tested is the same.
		const host = hostFor(chain, receiver, {maxCorrectionsPerCycle: 0});
		// the hint this cycle leaves behind is what the rival then invalidates
		await host.runCycle();

		// a second fetcher lands a batch between every cycle this one runs, so this one
		// starts from a stale hint, is corrected, and gives up without landing anything
		const rival = hostFor(chain, receiver);
		const reports: CycleReport[] = [];
		for (let tip = 111; tip <= 113; tip++) {
			chain.serve(BRANCH_A, tip);
			await rival.runCycle();
			reports.push(await host.runCycle());
		}

		expect(reports.map((report) => report.kind)).toEqual(['contended', 'contended', 'contended']);
		expect(host.consecutiveContentions).toBe(3);
		expect(host.consecutiveFailures).toBe(0);
		// and the state is whole: the rival did the work
		expect(await transferCount(receiver)).toBe(2);
	});
});

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// THE SAME HOST, WITH AND WITHOUT A WIRE
// ---------------------------------------------------------------------------
// A serverless runtime is a good home for the RECEIVING half (short, per-request
// work) and a poor one for this half, which needs a process that can sit in a
// loop. So the two deployments worth supporting both run this loop, and differ
// only in where the batch goes: over HTTP to an indexer-server elsewhere, or
// straight into a stream-builder in the same process. That choice arrives as one
// dependency, and these tests pin that it changes nothing else.
// ---------------------------------------------------------------------------

describe('a combined host and a split one', () => {
	function combinedHostFor(chain: FakeChain, receiver: Receiver): FetcherHost<TestABI> {
		return createFetcherHost<TestABI>(
			resolveFetcherHostConfig<TestABI>(
				{},
				{
					source: SOURCE,
					// NO endpoint and NO token: there is no network to point at and nobody to
					// authenticate to. A host that still demanded them would be demanding
					// configuration for a wire that is not there.
					nodeUrl: 'http://node.test',
					stream: {finality: FINALITY},
					retry: {attempts: 1},
					backoff: {pollIntervalMs: 10, catchUpDelayMs: 0, minRetryDelayMs: 5, jitter: 0, random: () => 0},
				},
			),
			{provider: chain.provider, target: createDirectIngestion(receiver.builder)},
		);
	}

	async function runToTip(host: FetcherHost<TestABI>): Promise<void> {
		const controller = new AbortController();
		await runFetcherLoop(host, {
			signal: controller.signal,
			sleep: instantSleep(),
			onReport: stopWhenCaughtUp(controller),
		});
	}

	it('reach the same state from the same chain, reorg included', async () => {
		const script = [
			[BRANCH_A, 110],
			[BRANCH_A, 118],
			[BRANCH_B, 119],
		] as const;

		const split = await deployReceiver();
		const splitChain = fakeChain();
		const combined = await deployReceiver();
		const combinedChain = fakeChain();

		for (const [logs, tip] of script) {
			splitChain.serve(logs as never, tip);
			await runToTip(hostFor(splitChain, split));

			combinedChain.serve(logs as never, tip);
			await runToTip(combinedHostFor(combinedChain, combined));
		}

		const snapshot = async (receiver: Receiver) => ({
			tokens: await Promise.all(['1', '2', '3', '4'].map((id) => ownerOf(receiver, id))),
			transfers: await transferCount(receiver),
		});

		const viaWire = await snapshot(split);
		expect(await snapshot(combined)).toEqual(viaWire);
		// and it is not two empty states agreeing: the reorg landed on both, derived by
		// the receiver from ranges neither host knew anything about
		expect(viaWire.tokens).toEqual([ALICE, expect.any(String), undefined, ALICE]);
		expect(viaWire.transfers).toBe(3);

		// the split one really did use the wire, and the combined one really did not
		expect(split.requests.length).toBeGreaterThan(0);
		expect(combined.requests.length).toBe(0);
	});

	it('is corrected the same way, a 409 and a thrown refusal meaning one thing', async () => {
		const chain = fakeChain();
		const receiver = await deployReceiver();
		chain.serve(BRANCH_A, 110);

		const host = combinedHostFor(chain, receiver);
		await host.runCycle();

		// a second sender moves the cursor under it, exactly as in the split case. Over
		// HTTP that comes back as a 409; in process it is a thrown
		// `UnexpectedFromBlockError`, and the cycle must follow it either way.
		chain.serve(BRANCH_A, 118);
		await hostFor(chain, receiver).runCycle();
		const report = await host.runCycle();

		expect(report).toMatchObject({kind: 'progress', outcome: {corrections: 1}});
		expect(await transferCount(receiver)).toBe(3);
	});

	it('refuses to start when there is neither a wire to use nor a target to use instead', async () => {
		const chain = fakeChain();
		const config = resolveFetcherHostConfig<TestABI>(
			{},
			{source: SOURCE, nodeUrl: 'http://node.test', stream: {finality: FINALITY}},
		);

		// resolving the configuration is fine: whether an endpoint is REQUIRED depends
		// on something the environment cannot say. Building the host is where both
		// facts are known, so that is where it is refused.
		const failure = (() => {
			try {
				createFetcherHost<TestABI>(config, {provider: chain.provider});
			} catch (err) {
				return err;
			}
		})();

		expect(failure).toBeInstanceOf(FetcherConfigError);
		expect((failure as Error).message).toMatch(/INGEST_ENDPOINT and INGEST_TOKEN are unset/);
		// and it names the way out for a host that has no wire on purpose
		expect((failure as Error).message).toMatch(/createDirectIngestion/);
		expect((failure as {retryable: boolean}).retryable).toBe(false);
	});

	it('says which of the two it is, in the line an operator reads at startup', async () => {
		const receiver = await deployReceiver();
		const chain = fakeChain();
		expect(combinedHostFor(chain, receiver).describe()).toContain('delivering in-process, with no wire');
		expect(hostFor(chain, receiver).describe()).toContain('pushing to http://indexer.test');
	});
});
