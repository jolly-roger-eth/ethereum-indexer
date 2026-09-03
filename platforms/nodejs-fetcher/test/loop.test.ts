import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it} from 'vitest';
import type {CycleReport} from '@etherfold/fetcher-host';
import {startFetcher, runFetcherProcess, stopOnSignals, type RunningFetcher} from '../src/index.js';
import {
	ALICE,
	fakeChain,
	FINALITY,
	SOURCE,
	START_BLOCK,
	startReceiver,
	TOKEN,
	transferLog,
	type FakeChain,
	type RunningReceiver,
	type TestABI,
} from './deployment.js';

const LOGS = [transferLog(101, 1), transferLog(104, 2), transferLog(116, 3)];

let receiver: RunningReceiver | undefined;
let running: RunningFetcher<TestABI> | undefined;

afterEach(async () => {
	await running?.stop();
	running = undefined;
	await receiver?.close();
	receiver = undefined;
});

function envFor(url: string, extra: Record<string, string> = {}) {
	return {
		INDEXING_SOURCE: JSON.stringify(SOURCE),
		INGEST_ENDPOINT: url,
		INGEST_TOKEN: TOKEN,
		// never used: the provider is injected below. It is set anyway because
		// resolving configuration is part of what these tests drive, and a fetcher
		// deployment that could start without a node URL would be one that indexes
		// nothing while looking healthy.
		ETH_NODE_URI: 'https://eth-mainnet.example/v2/AN-API-KEY',
		STREAM_FINALITY: String(FINALITY),
		POLL_INTERVAL_MS: '5',
		MIN_RETRY_DELAY_MS: '5',
		RETRY_ATTEMPTS: '1',
		...extra,
	};
}

/** Start a loop and resolve once it has done what the caller is waiting for. */
function fetcherAgainst(
	chain: FakeChain,
	url: string,
	until: (report: CycleReport) => boolean,
	extra?: Record<string, string>,
	fetchImpl?: typeof globalThis.fetch,
): {running: RunningFetcher<TestABI>; reached: Promise<CycleReport>} {
	let settle: (report: CycleReport) => void;
	const reached = new Promise<CycleReport>((resolve) => (settle = resolve));
	const started = startFetcher<TestABI>({
		env: envFor(url, extra),
		handleSignals: false,
		dependencies: {
			provider: chain.provider,
			...(fetchImpl ? {fetch: fetchImpl as never} : {}),
		},
		onReport: (report) => {
			if (until(report)) {
				settle(report);
			}
		},
	});
	return {running: started, reached};
}

const caughtUp = (report: CycleReport) => report.kind === 'progress' && report.caughtUp;

// ---------------------------------------------------------------------------

describe('the node adapter drives the fetcher over real HTTP', () => {
	it('follows the chain tip and lands the logs in the server it pushes to', async () => {
		receiver = await startReceiver();
		const chain = fakeChain();
		chain.serve(LOGS, 110);

		const started = fetcherAgainst(chain, receiver.url, caughtUp);
		running = started.running;
		await started.reached;

		expect(await receiver.transfers()).toBe(2); // block 116 is above this tip
		expect(await receiver.ownerOf('1')).toBe(ALICE);
	});

	it('keeps following as the tip moves, without being told where it got to', async () => {
		receiver = await startReceiver();
		const chain = fakeChain();
		chain.serve(LOGS, 110);

		let cycles = 0;
		const started = fetcherAgainst(chain, receiver.url, (report) => {
			if (caughtUp(report) && ++cycles === 1) {
				chain.serve(LOGS, 120);
			}
			return cycles >= 1 && report.kind === 'progress' && report.outcome.toBlock === 120;
		});
		running = started.running;
		await started.reached;

		expect(await receiver.transfers()).toBe(3);
	});

	it('backs off instead of exiting when the server is unreachable, and recovers when it returns', async () => {
		receiver = await startReceiver();
		const chain = fakeChain();
		chain.serve(LOGS, 110);

		// The outage is simulated at the TRANSPORT rather than by closing the socket,
		// which is deliberate: what a closed port does is the one part of this neither
		// package owns (here it is a 10s connect timeout rather than a refusal), and
		// what is under test is the loop's reaction to an unreachable server, not the
		// operating system's. The server on the other side is real throughout, so the
		// recovery is real too.
		let outages = 3;
		const reports: CycleReport[] = [];
		const started = fetcherAgainst(
			chain,
			receiver.url,
			(report) => {
				reports.push(report);
				return caughtUp(report);
			},
			undefined,
			(url, init) => {
				if (outages-- > 0) {
					return Promise.reject(new Error('connect ECONNREFUSED'));
				}
				return fetch(url as string, init as RequestInit);
			},
		);
		running = started.running;
		await started.reached;

		// it stayed up through every outage, escalating rather than exiting, and landed
		// the batch as soon as the server answered
		expect(reports.filter((report) => report.kind === 'retry').length).toBe(3);
		expect(reports.filter((report) => report.kind === 'fatal').length).toBe(0);
		expect(await receiver.transfers()).toBe(2);
	});

	it('exits non-zero on a refusal no retry can fix, instead of staying up achieving nothing', async () => {
		receiver = await startReceiver();
		const chain = fakeChain();
		chain.serve(LOGS, 110);

		const code = await runFetcherProcess<TestABI>({
			env: envFor(receiver.url, {INGEST_TOKEN: 'not-the-token'}),
			handleSignals: false,
			dependencies: {provider: chain.provider},
		});

		expect(code).toBe(1);
		expect(await receiver.transfers()).toBe(0);
	});

	it('exits non-zero when its configuration is incomplete, naming the variable', async () => {
		const env = envFor('http://unused.test');
		delete (env as Record<string, string | undefined>).INGEST_TOKEN;
		const code = await runFetcherProcess<TestABI>({env: {...env, INGEST_TOKEN: ''}, handleSignals: false});
		expect(code).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// THE PROPERTY THE STATELESS DESIGN EXISTS FOR
// ---------------------------------------------------------------------------

describe('killing the process mid-run', () => {
	it('loses nothing, and the replacement is put back on track by the server', async () => {
		receiver = await startReceiver();
		const chain = fakeChain();
		chain.serve(LOGS, 110);

		// killed with a cycle IN FLIGHT: the logs have been read from the node and
		// nothing has been delivered. A fetcher that had written a cursor before
		// fetching would come back believing this range was done.
		const release = chain.hangOnNextFetch();
		const doomed = startFetcher<TestABI>({
			env: envFor(receiver.url),
			handleSignals: false,
			dependencies: {provider: chain.provider},
		});
		const abandoned = doomed.stop();
		release();
		await abandoned;

		// a NEW process, carrying nothing across: no file was written and none is read
		const replacement = fetcherAgainst(chain, receiver.url, caughtUp);
		running = replacement.running;
		expect(replacement.running.host.fetcher.cursorHint).toBeUndefined();
		await replacement.reached;

		// every log applied exactly once, whatever the killed process managed to do
		expect(await receiver.transfers()).toBe(2);
		expect(await receiver.ownerOf('1')).toBe(ALICE);
	});

	it('is corrected by a 409 when a second fetcher moved the cursor, with no operator involved', async () => {
		receiver = await startReceiver();
		const chain = fakeChain();
		chain.serve(LOGS, 110);

		// one fetcher gets ahead
		const first = fetcherAgainst(chain, receiver.url, caughtUp);
		await first.reached;
		await first.running.stop();

		// a second one starts from scratch against a server that has already moved on:
		// the restart case and the redundant-fetcher case are the same case
		chain.serve(LOGS, 120);
		const second = fetcherAgainst(chain, receiver.url, caughtUp);
		running = second.running;
		const report = await second.reached;

		expect(report).toMatchObject({kind: 'progress'});
		// it started where the SERVER said, which is inside the finality window rather
		// than at the source's start block or at the last thing anybody remembered
		expect(report.kind === 'progress' && report.outcome.fromBlock).toBe(107);
		expect(await receiver.transfers()).toBe(3);
	});

	it('stops on a signal without abandoning the cycle in flight', async () => {
		receiver = await startReceiver();
		const chain = fakeChain();
		chain.serve(LOGS, 110);

		const started = startFetcher<TestABI>({
			env: envFor(receiver.url),
			handleSignals: true,
			dependencies: {provider: chain.provider},
		});
		const release = chain.hangOnNextFetch();
		process.emit('SIGTERM', 'SIGTERM');
		release();
		const summary = await started.stopped;

		expect(summary.stoppedBecause).toBe('stopped');
		expect(summary.cycles).toBe(1);
		// the cycle in flight ran to completion: the batch it had fetched was pushed
		expect(await receiver.transfers()).toBe(2);
		expect(process.listenerCount('SIGTERM')).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// THE SIGNAL HALF, ON ITS OWN
// ---------------------------------------------------------------------------
// "A process, its signals and an exit code" is this adapter's whole
// contribution, and the middle third is reusable on its own because
// `startFetcher` is not the only shape that needs it: `etherfold run` builds its
// own host (it also runs the receiving half in-process) and drives
// `runFetcherLoop` itself, so it takes this rather than writing a second answer
// to "which signals, and what happens to the cycle in flight".
// ---------------------------------------------------------------------------

describe('stopOnSignals', () => {
	it('aborts on the signals a container sends, and hands back the undo', () => {
		const controller = new AbortController();
		const before = {term: process.listenerCount('SIGTERM'), int: process.listenerCount('SIGINT')};

		const release = stopOnSignals(controller);
		expect(process.listenerCount('SIGTERM')).toBe(before.term + 1);
		expect(process.listenerCount('SIGINT')).toBe(before.int + 1);

		process.emit('SIGTERM', 'SIGTERM');
		expect(controller.signal.aborted).toBe(true);

		// a caller that stops for another reason must not leave a listener behind
		release();
		expect(process.listenerCount('SIGTERM')).toBe(before.term);
		expect(process.listenerCount('SIGINT')).toBe(before.int);
	});
});

// ---------------------------------------------------------------------------

describe('the adapter is scheduling and configuration, and nothing else', () => {
	const here = fileURLToPath(new URL('.', import.meta.url));
	const sources = ['../src/index.ts', '../src/bin.ts'].map((path) => ({
		path,
		// comments stripped, so that prose ABOUT the boundary (which this package is
		// full of) cannot fail a scan of what the code does
		text: readFileSync(`${here}${path}`, 'utf-8')
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/(^|[^:])\/\/.*$/gm, '$1'),
	}));

	it('reads the files it claims to check', () => {
		expect(sources.length).toBe(2);
		expect(sources.every((source) => source.text.includes('import'))).toBe(true);
		expect(sources[0].text.length).toBeGreaterThan(500);
	});

	for (const {pattern, why} of [
		{pattern: /writeFile|appendFile|mkdir|openSync|localStorage/, why: 'anywhere to persist a cursor'},
		{pattern: /eth_getLogs|getLogEvents/, why: 'fetch logic, which belongs to the core'},
		{
			pattern: /unconfirmedBlocks|generateStreamToAppend|removed:\s*true/,
			why: 'reorg logic, which belongs to the receiver',
		},
		{pattern: /\bfromBlock\b|\blastSync\b/, why: 'an opinion about where the next batch starts'},
	]) {
		it(`contains no ${why}`, () => {
			expect(sources.filter((source) => pattern.test(source.text)).map((source) => source.path)).toEqual([]);
		});
	}

	it('never writes a credential, through the whole of a run', async () => {
		receiver = await startReceiver();
		const chain = fakeChain();
		chain.serve(LOGS, 110);

		// the real logger, hooked in `test/vitest/capture-logs.ts` before any source
		// module was imported, which is the only moment a hook takes effect
		const from = globalThis.__logLines.length;

		// a wrong token, so the 401 path is exercised as well as the startup line
		const code = await runFetcherProcess<TestABI>({
			env: envFor(receiver.url, {INGEST_TOKEN: 'a-token-the-server-does-not-have'}),
			handleSignals: false,
			dependencies: {provider: chain.provider},
		});
		expect(code).toBe(1);

		const lines = globalThis.__logLines.slice(from);
		const everything = lines.join('\n');
		expect(lines.length).toBeGreaterThan(0);
		expect(everything).not.toContain('a-token-the-server-does-not-have');
		expect(everything).not.toContain('AN-API-KEY');
		// and it still says what an operator needs: the variable to look at, and the
		// node it was pointed at, by host
		expect(everything).toContain('INGEST_TOKEN');
		expect(everything).toContain('eth-mainnet.example');
		expect(START_BLOCK).toBe(100);
	});
});
