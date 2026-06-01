import {afterEach, describe, expect, it, vi} from 'vitest';
import type {AddressInfo} from 'node:net';
import type {Server} from 'node:http';
import {SimpleServer} from '../src/server/simple.js';

// ---------------------------------------------------------------------------
// Harness (same approach as feedRoute.test.ts): construct the server, inject
// collaborators directly, exercise the real route handlers over HTTP.
// ---------------------------------------------------------------------------

const API_KEY = 'test-key';

type Deferred<T> = {promise: Promise<T>; resolve: (v: T) => void; reject: (e: any) => void};
function deferred<T>(): Deferred<T> {
	let resolve!: (v: T) => void;
	let reject!: (e: any) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return {promise, resolve, reject};
}

const FRESH_SYNC = {lastToBlock: 5, latestBlock: 10, lastFromBlock: 0, unconfirmedBlocks: [], context: {}};

function makeServer(indexer: any, opts?: {indexing?: boolean}) {
	const server = new SimpleServer<any, any>({
		nodeURL: 'http://localhost:0',
		folder: '/tmp/ei-server-indexing-test',
		processorPath: 'unused',
		disableSecurity: false,
		port: 0,
	});
	(server as any).indexer = indexer;
	(server as any).processor = {json: undefined, _json: undefined};
	(server as any).lastSync = {...FRESH_SYNC};
	(server as any).indexing = opts?.indexing ?? false;
	process.env.ETHEREUM_INDEXER_API_KEY = API_KEY;
	return server;
}

async function listen(server: SimpleServer<any, any>) {
	const httpServer: Server = await (server as any).startServer();
	const {port} = httpServer.address() as AddressInfo;
	return {httpServer, base: `http://127.0.0.1:${port}`};
}

let openServers: Server[] = [];
afterEach(async () => {
	for (const s of openServers) {
		await new Promise<void>((r) => s.close(() => r()));
	}
	openServers = [];
	vi.restoreAllMocks();
	vi.useRealTimers();
});

async function post(base: string, path: string, body: any, headers: Record<string, string> = {}) {
	const res = await fetch(`${base}${path}`, {
		method: 'POST',
		headers: {'content-type': 'application/json', ...headers},
		body: JSON.stringify(body),
	});
	const text = await res.text();
	return {status: res.status, json: text ? JSON.parse(text) : undefined};
}

async function get(base: string, path: string) {
	const res = await fetch(`${base}${path}`);
	const text = await res.text();
	return {status: res.status, json: text ? JSON.parse(text) : undefined};
}

// ---------------------------------------------------------------------------
// Characterization (current behaviour — should PASS as-is)
// ---------------------------------------------------------------------------

describe('SimpleServer indexing — characterization (current behaviour)', () => {
	it('/indexMore returns "Indexing Already" when the auto-loop is active', async () => {
		const indexer = {defaultFromBlock: 0, indexMore: vi.fn(async () => ({...FRESH_SYNC}))};
		const server = makeServer(indexer, {indexing: true});
		const {httpServer, base} = await listen(server);
		openServers.push(httpServer);

		const res = await post(base, '/indexMore', {}, {authorization: API_KEY});
		expect(res.json).toEqual({error: {code: 4040, message: 'Indexing Already'}});
		expect(indexer.indexMore).not.toHaveBeenCalled();
	});

	it('/indexMore runs indexMore and returns lastSync when idle', async () => {
		const indexer = {defaultFromBlock: 0, indexMore: vi.fn(async () => ({...FRESH_SYNC, lastToBlock: 7}))};
		const server = makeServer(indexer);
		const {httpServer, base} = await listen(server);
		openServers.push(httpServer);

		const res = await post(base, '/indexMore', {}, {authorization: API_KEY});
		expect(indexer.indexMore).toHaveBeenCalledTimes(1);
		expect(res.json.lastSync.lastToBlock).toBe(7);
	});

	it('/ status includes an `indexing` field', async () => {
		const indexer = {defaultFromBlock: 0, indexMore: vi.fn()};
		const server = makeServer(indexer);
		const {httpServer, base} = await listen(server);
		openServers.push(httpServer);

		const res = await get(base, '/');
		expect(res.json).toHaveProperty('indexing');
	});

	it('/ returns a shaped 503 (not a 500) when the indexer is not set up', async () => {
		const server = makeServer(undefined);
		(server as any).indexer = undefined;
		(server as any).lastSync = undefined;
		const {httpServer, base} = await listen(server);
		openServers.push(httpServer);

		const res = await get(base, '/');
		expect(res.status).toBe(503);
		expect(res.json).toHaveProperty('error');
		expect(res.json.error.code).toBe(503);
	});
});

// ---------------------------------------------------------------------------
// MEDIUM-5: all indexing entrypoints must serialize. Two concurrent manual
// /indexMore calls must NOT run indexer.indexMore() concurrently.
// ---------------------------------------------------------------------------

describe('SimpleServer indexing — MEDIUM-5 (serialize concurrent /indexMore)', () => {
	it('does not run two manual /indexMore calls concurrently', async () => {
		let inFlight = 0;
		let maxConcurrent = 0;
		const gate = deferred<void>();
		let firstStarted = deferred<void>();

		const indexer = {
			defaultFromBlock: 0,
			indexMore: vi.fn(async () => {
				inFlight++;
				maxConcurrent = Math.max(maxConcurrent, inFlight);
				if (inFlight === 1) firstStarted.resolve();
				// hold the first call until the gate opens so the second call overlaps in time
				await gate.promise;
				inFlight--;
				return {...FRESH_SYNC};
			}),
		};
		const server = makeServer(indexer);
		const {httpServer, base} = await listen(server);
		openServers.push(httpServer);

		const p1 = post(base, '/indexMore', {}, {authorization: API_KEY});
		await firstStarted.promise; // ensure the first indexMore is actually executing
		const p2 = post(base, '/indexMore', {}, {authorization: API_KEY});

		// give the second request time to reach the handler while the first is still in flight
		await new Promise((r) => setTimeout(r, 30));
		gate.resolve();
		await Promise.all([p1, p2]);

		expect(maxConcurrent).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// MEDIUM-4: the auto-index loop must (a) back off (not retry at a fixed 1s)
// across repeated failures, and (b) surface the last error in the / status.
// ---------------------------------------------------------------------------

describe('SimpleServer indexing — MEDIUM-4 (auto-index backoff + error surfaced)', () => {
	it('surfaces the last error in / status after an auto-index failure', async () => {
		const boom = new Error('rpc down');
		const indexer = {
			defaultFromBlock: 0,
			indexMore: vi.fn(async () => {
				throw boom;
			}),
		};
		const server = makeServer(indexer);
		const {httpServer, base} = await listen(server);
		openServers.push(httpServer);

		// run one iteration of the auto-index loop (it will fail and schedule a retry)
		await (server as any).index();
		// clear the scheduled retry timer so it doesn't keep firing during the test
		const t = (server as any).indexingTimeout;
		if (t) clearTimeout(t);

		const res = await get(base, '/');
		expect(res.json.lastError).toBeDefined();
		expect(String(res.json.lastError.message ?? res.json.lastError)).toContain('rpc down');
	});

	it('uses increasing backoff delays across consecutive failures (not a fixed 1s)', async () => {
		vi.useFakeTimers();
		const delays: number[] = [];
		const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: any, ms?: number) => {
			delays.push(ms ?? 0);
			// do NOT actually schedule, to avoid recursion; return a fake handle
			return 0 as any;
		}) as any);

		const indexer = {
			defaultFromBlock: 0,
			indexMore: vi.fn(async () => {
				throw new Error('rpc down');
			}),
		};
		const server = makeServer(indexer);

		// drive several failing iterations manually
		await (server as any).index();
		await (server as any).index();
		await (server as any).index();

		setTimeoutSpy.mockRestore();

		// the retry delays should not all be identical (backoff), and should increase
		expect(delays.length).toBeGreaterThanOrEqual(3);
		expect(new Set(delays).size).toBeGreaterThan(1);
		expect(delays[1]).toBeGreaterThan(delays[0]);
	});
});
