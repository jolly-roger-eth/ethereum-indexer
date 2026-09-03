import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {CycleReport} from '@etherfold/fetcher-host';
import type {RunningFetcher} from '@etherfold/platform-nodejs-fetcher';
import {afterEach, describe, expect, it} from 'vitest';
import {fetch as startFetch, fetchMain, prepareFetching, type FetchDependencies} from '../src/index.js';
import type {Options} from '../src/types.js';
import {abi, ALICE, BOB, CONTRACT, fakeChain, noChain, START_BLOCK, transfer, ZERO} from './utils/chain.js';
import {ENDPOINT, FINALITY, SOURCE, startReceiver, TOKEN, type RunningReceiver} from './utils/receiver.js';

// ---------------------------------------------------------------------------------------------------
// `etherfold fetch`: THE CHAIN-FACING HALF, AS A COMMAND
// ---------------------------------------------------------------------------------------------------
// It is a FRONT DOOR and not a new deployable: `platforms/nodejs-fetcher` already
// ships the loop, the signals and the exit code, and what it did not have is a
// flag surface. So what is asserted here is the command's own three jobs --
// resolving flags with the environment behind them into what that adapter takes,
// refusing what a stateless half cannot own, and actually driving the loop --
// with the adapter underneath doing exactly what its own tests already pin.
//
// Everything below the provider is the shipped thing: the real `LogFetcher`, the
// real HTTP ingestion, the real indexer-server on the other end of the wire
// (`test/utils/receiver.ts`). Only the NODE is fake, and the socket is replaced
// by the in-process `fetch` the test supplies.
// ---------------------------------------------------------------------------------------------------

/** Logs every 10 blocks, so a bounded fetch range takes several cycles to cover them. */
const SPREAD = [10, 20, 30, 40, 50, 60, 70, 80].map((offset, index) =>
	transfer(START_BLOCK + offset, `0xa${offset}`, index === 0 ? ZERO : ALICE, index === 0 ? ALICE : BOB, BigInt(index)),
);
const TIP = START_BLOCK + 100;

/**
 * What a fetcher deployment configures through the environment, as the adapter
 * has always read it: the source, the wire identity, and the waits.
 *
 * Bounded ranges and short waits so several cycles happen quickly; nothing here
 * is a CLI input, which is the point -- the command puts flags in front of the
 * four inputs that vary, and the rest stays the fetcher host's own configuration.
 */
const DEPLOYMENT = {
	INDEXING_SOURCE: JSON.stringify(SOURCE),
	STREAM_FINALITY: String(FINALITY),
	MAX_BLOCKS_PER_FETCH: '20',
	POLL_INTERVAL_MS: '5',
	CATCH_UP_DELAY_MS: '0',
	MIN_RETRY_DELAY_MS: '5',
	RETRY_ATTEMPTS: '1',
};

/** The flags: a node to read, and a server to push to. No processor, no store, no database. */
const FETCHING: Options = {
	nodeUrl: 'http://localhost:0',
	ingestEndpoint: ENDPOINT,
	ingestToken: TOKEN,
};

let running: RunningFetcher<typeof abi> | undefined;
let temporary: string | undefined;

afterEach(async () => {
	await running?.stop().catch(() => undefined);
	running = undefined;
	if (temporary) rmSync(temporary, {recursive: true, force: true});
	temporary = undefined;
});

function depsFor(
	chain: ReturnType<typeof fakeChain>,
	receiver: RunningReceiver,
	extra: FetchDependencies = {},
): FetchDependencies {
	return {
		provider: chain.provider,
		fetch: receiver.fetch,
		// the test runner's process is not this command's to install handlers on
		handleSignals: false,
		env: DEPLOYMENT,
		...extra,
	};
}

/** Poll something the running fetcher published until it says what we are waiting for. */
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string): Promise<T> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		const value = await read();
		if (done(value)) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; last saw ${JSON.stringify(value)}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

// ---------------------------------------------------------------------------------------------------

describe('the command runs a real fetch loop against a node and pushes to a remote receiver', () => {
	it('lands every log in the server it pushes to, and keeps going after the tip', async () => {
		const receiver = await startReceiver();
		const chain = fakeChain().serve(SPREAD, TIP);

		running = await startFetch<typeof abi>(FETCHING, depsFor(chain, receiver));

		await until(
			() => receiver.transfers(),
			(transfers) => transfers === SPREAD.length,
			'every log to reach the receiver',
		);
		expect(await receiver.ownerOf(0n)).toBe(ALICE.toLowerCase());

		// a partial range is never pushed, so every batch that crossed covers a
		// contiguous span and the ranges the node was asked for are contiguous too
		const ranges = chain.logRanges;
		for (const [index, range] of ranges.entries()) {
			if (index === 0) continue;
			expect(range.from).toBeLessThanOrEqual(ranges[index - 1]!.to + 1);
		}
		expect(receiver.requests.some((request) => request.path === '/ingest' && request.status === 200)).toBe(true);

		// stopping is a SIGNAL and never a report: it reached the tip several cycles
		// ago and it is still cycling
		const atTheTip = running.host.cyclesRun;
		await until(
			async () => running!.host.cyclesRun,
			(cycles) => cycles > atTheTip + 2,
			'more cycles after the tip',
		);
		expect(await receiver.transfers()).toBe(SPREAD.length);
	});

	it('holds no cursor: a second run starts where the RECEIVER says, not at the start block', async () => {
		const receiver = await startReceiver();
		const first = fakeChain().serve(SPREAD, TIP);
		const interrupted = await startFetch<typeof abi>(FETCHING, depsFor(first, receiver));
		await until(
			() => receiver.transfers(),
			(transfers) => transfers === SPREAD.length,
			'the first fetcher to catch up',
		);
		await interrupted.stop();

		// a NEW fetcher, carrying nothing across: no file was written and none is
		// read, and it has no hint of its own
		const second = fakeChain().serve(SPREAD, TIP);
		running = await startFetch<typeof abi>(FETCHING, depsFor(second, receiver));
		expect(running.host.fetcher.cursorHint).toBeUndefined();

		await until(
			async () => second.logRanges.length,
			(asked) => asked > 0,
			'the second fetcher to read the chain',
		);
		expect(second.logRanges[0]!.from).toBeGreaterThan(START_BLOCK);
		// and nothing was applied twice
		expect(await receiver.transfers()).toBe(SPREAD.length);
	});
});

// ---------------------------------------------------------------------------------------------------
// FLAGS FIRST, THE ENVIRONMENT BEHIND THEM, INTO WHAT THE ADAPTER TAKES
// ---------------------------------------------------------------------------------------------------

describe('the resolution reaching the host', () => {
	it('takes the flag when both are there, and the variable when the flag is absent', async () => {
		const start = await prepareFetching<typeof abi>(
			{nodeUrl: 'http://from.the.flag', ingestEndpoint: ENDPOINT},
			{
				env: {
					...DEPLOYMENT,
					ETH_NODE_URI: 'http://from.env',
					INGEST_ENDPOINT: 'http://also.from.env',
					INGEST_TOKEN: TOKEN,
				},
			},
		);

		expect(start.nodeUrl).toBe('http://from.the.flag');
		expect(start.endpoint).toBe(ENDPOINT);
		// no flag was typed for it, which is the preferred way to give a secret
		expect(start.token).toBe(TOKEN);
		expect(start.source).toEqual(SOURCE);
	});

	it('carries the rate limit through, and leaves the rest of the deployment to the environment', async () => {
		const start = await prepareFetching<typeof abi>({...FETCHING, rps: '7'}, {env: DEPLOYMENT});
		expect(start.requestsPerSecond).toBe(7);
		expect(start.env).toBe(DEPLOYMENT);
	});

	it('takes a source from a deployments folder, with no processor module anywhere', async () => {
		temporary = mkdtempSync(join(tmpdir(), 'etherfold-fetch-'));
		writeFileSync(join(temporary, '.chainId'), '1');
		writeFileSync(
			join(temporary, 'NFT.json'),
			JSON.stringify({address: CONTRACT, abi, receipt: {blockNumber: START_BLOCK}}),
		);

		const {INDEXING_SOURCE, ...noSourceVariable} = DEPLOYMENT;
		const start = await prepareFetching({...FETCHING, deployments: temporary}, {env: noSourceVariable});

		expect(start.source).toMatchObject({chainId: '1'});
		expect(start.source?.contracts).toMatchObject([{address: CONTRACT, startBlock: START_BLOCK}]);
	});
});

// ---------------------------------------------------------------------------------------------------
// WHAT A STATELESS HALF REFUSES
// ---------------------------------------------------------------------------------------------------

describe('the refusals', () => {
	it('refuses --store and --db, because this command owns no state', async () => {
		const chain = noChain();
		await expect(
			startFetch({...FETCHING, store: 'sqlite'}, {provider: chain.provider, env: DEPLOYMENT}),
		).rejects.toThrow(/--store is not accepted by `etherfold fetch`.*holds no state/s);
		await expect(
			startFetch({...FETCHING, db: ':memory:'}, {provider: chain.provider, env: DEPLOYMENT}),
		).rejects.toThrow(/--db \(DB\) is not accepted by `etherfold fetch`.*holds no state/s);
		expect(chain.calls).toEqual([]);
	});

	it('refuses a processor, because the chain-facing half holds none (ADR-0003)', async () => {
		await expect(startFetch({...FETCHING, processor: './nfts.js'}, {env: DEPLOYMENT})).rejects.toThrow(
			/--processor is not accepted by `etherfold fetch`.*ADR-0003/s,
		);
	});

	it('refuses a missing node URL, endpoint or token by flag AND variable, before any chain call', async () => {
		const chain = noChain();
		const without = (options: Options) =>
			startFetch(options, {provider: chain.provider, env: {INDEXING_SOURCE: DEPLOYMENT.INDEXING_SOURCE}});

		await expect(without({ingestEndpoint: ENDPOINT, ingestToken: TOKEN})).rejects.toThrow(
			/--node-url \(ETH_NODE_URI\) is required by `etherfold fetch`/,
		);
		await expect(without({nodeUrl: 'http://n', ingestToken: TOKEN})).rejects.toThrow(
			/--ingest-endpoint \(INGEST_ENDPOINT\) is required by `etherfold fetch`/,
		);
		await expect(without({nodeUrl: 'http://n', ingestEndpoint: ENDPOINT})).rejects.toThrow(
			/--ingest-token \(INGEST_TOKEN\) is required by `etherfold fetch`/,
		);
		expect(chain.calls).toEqual([]);
	});

	it('refuses a source it can only get from a processor module, naming both explicit forms', async () => {
		await expect(startFetch(FETCHING, {env: {}})).rejects.toThrow(
			/--deployments \(INDEXING_SOURCE\) is required by `etherfold fetch`.*holds NO processor/s,
		);
	});
});

// ---------------------------------------------------------------------------------------------------
// HOW IT ENDS, AND WHAT THE PROCESS EXITS WITH
// ---------------------------------------------------------------------------------------------------
// The same distinction the retired binary made, because it is the same function
// underneath: a fetcher that stays up while achieving nothing is
// indistinguishable from a working one until somebody reads the state it is not
// producing.
// ---------------------------------------------------------------------------------------------------

describe('the process exits on the code the fetcher resolved', () => {
	it('exits 0 when a signal asks it to stop, having pushed what it fetched', async () => {
		const receiver = await startReceiver();
		const chain = fakeChain().serve(SPREAD, TIP);
		const exits: number[] = [];
		const reports: CycleReport[] = [];
		const listeningBefore = process.listenerCount('SIGTERM');

		await fetchMain<typeof abi>(FETCHING, {
			...depsFor(chain, receiver, {
				// the signals a container sends are what stops a follower, so this is the
				// ordinary way it ends: handlers ON, and one emitted once it is running
				handleSignals: true,
				onReport: (report) => {
					reports.push(report);
					if (reports.length === 1) process.emit('SIGTERM', 'SIGTERM');
				},
			}),
			exit: (code) => exits.push(code),
			error: () => {},
		});

		expect(exits).toEqual([0]);
		expect(reports[0]).toMatchObject({kind: 'progress'});
		expect(await receiver.transfers()).toBeGreaterThan(0);
		// and it left no handler behind on the process it was stopped through
		expect(process.listenerCount('SIGTERM')).toBe(listeningBefore);
	});

	it('exits non-zero on a refusal no retry can fix, instead of staying up achieving nothing', async () => {
		const receiver = await startReceiver();
		const chain = fakeChain().serve(SPREAD, TIP);
		const exits: number[] = [];

		await fetchMain<typeof abi>(
			{...FETCHING, ingestToken: 'not-the-token'},
			{...depsFor(chain, receiver), exit: (code) => exits.push(code), error: () => {}},
		);

		expect(exits).toEqual([1]);
		expect(await receiver.transfers()).toBe(0);
		expect(receiver.requests.some((request) => request.status === 401)).toBe(true);
	});

	it('exits non-zero on a configuration it refuses, without starting a loop', async () => {
		const chain = noChain();
		const exits: number[] = [];
		const errors: unknown[] = [];

		await fetchMain(
			{ingestEndpoint: ENDPOINT, ingestToken: TOKEN},
			{
				provider: chain.provider,
				env: {INDEXING_SOURCE: DEPLOYMENT.INDEXING_SOURCE},
				exit: (code) => exits.push(code),
				error: (...args) => errors.push(...args),
			},
		);

		expect(exits).toEqual([1]);
		expect(String(errors[0])).toMatch(/--node-url \(ETH_NODE_URI\)/);
		expect(chain.calls).toEqual([]);
	});
});
