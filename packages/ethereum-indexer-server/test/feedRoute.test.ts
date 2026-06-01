import {afterEach, describe, expect, it} from 'vitest';
import type {AddressInfo} from 'node:net';
import type {Server} from 'node:http';
import {SimpleServer} from '../src/server/simple.js';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------
// The SimpleServer routes only need a few collaborators (indexer, processor,
// lastSync, indexing flag). Rather than drive the full setupIndexing() (which
// imports a processor module and talks to an RPC node), we construct the server
// and set those collaborators directly, then start the HTTP server on an
// OS-assigned free port and exercise the real route handlers over HTTP.

type FakeIndexer = {
	defaultFromBlock: number;
	feed: (eventStream: any[]) => Promise<any>;
	feedCalls: any[][];
};

function makeFakeIndexer(): FakeIndexer {
	const feedCalls: any[][] = [];
	return {
		defaultFromBlock: 0,
		feedCalls,
		async feed(eventStream: any[]) {
			feedCalls.push(eventStream);
			return {lastToBlock: 0, latestBlock: 0, lastFromBlock: 0, unconfirmedBlocks: [], context: {}};
		},
	};
}

const API_KEY = 'test-key';

async function startTestServer(opts?: {indexing?: boolean; indexer?: FakeIndexer}) {
	const indexer = opts?.indexer ?? makeFakeIndexer();
	const server = new SimpleServer<any, any>({
		nodeURL: 'http://localhost:0',
		folder: '/tmp/ei-server-test',
		processorPath: 'unused',
		disableSecurity: false,
		port: 0,
	});
	// inject collaborators directly (TS `private`/`protected` is compile-time only)
	(server as any).indexer = indexer;
	(server as any).processor = {json: undefined, _json: undefined};
	(server as any).lastSync = {lastToBlock: 5, latestBlock: 10, lastFromBlock: 0, unconfirmedBlocks: [], context: {}};
	(server as any).indexing = opts?.indexing ?? false;

	process.env.ETHEREUM_INDEXER_API_KEY = API_KEY;
	const httpServer: Server = await (server as any).startServer();
	const {port} = httpServer.address() as AddressInfo;
	return {server, indexer, httpServer, base: `http://127.0.0.1:${port}`};
}

function close(httpServer: Server) {
	return new Promise<void>((resolve) => httpServer.close(() => resolve()));
}

let openServers: Server[] = [];
afterEach(async () => {
	for (const s of openServers) {
		await close(s);
	}
	openServers = [];
});

async function post(base: string, path: string, body: any, headers: Record<string, string> = {}) {
	const res = await fetch(`${base}${path}`, {
		method: 'POST',
		headers: {'content-type': 'application/json', ...headers},
		body: JSON.stringify(body),
	});
	const text = await res.text();
	let json: any;
	try {
		json = text ? JSON.parse(text) : undefined;
	} catch {
		json = undefined;
	}
	return {status: res.status, json, text};
}

// ---------------------------------------------------------------------------
// Characterization tests (CURRENT behaviour — these should PASS as-is)
// ---------------------------------------------------------------------------

describe('SimpleServer /feed route — characterization (current behaviour)', () => {
	it('returns Forbidden when the api key is missing/wrong', async () => {
		const {httpServer, base, indexer} = await startTestServer();
		openServers.push(httpServer);

		const res = await post(base, '/feed', {events: [{foo: 1}]}, {authorization: 'wrong-key'});

		expect(res.json).toEqual({error: {code: 4030, message: 'Forbidden'}});
		// must NOT have fed anything when unauthorized
		expect(indexer.feedCalls.length).toBe(0);
	});

	it('returns the "Server is Indexing" error when indexing is in progress', async () => {
		const {httpServer, base, indexer} = await startTestServer({indexing: true});
		openServers.push(httpServer);

		const res = await post(base, '/feed', {events: [{foo: 1}]}, {authorization: API_KEY});

		expect(res.json).toEqual({error: {code: 222, message: 'Server is Indexing, cannot import.'}});
		expect(indexer.feedCalls.length).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Failing test demonstrating HIGH-3: /feed reads ctx.body.events instead of
// ctx.request.body.events, so an authorized call with a real events array
// throws (the route is effectively dead).
//
// EXPECTED (after fix): an authorized /feed with events forwards them to
// indexer.feed and responds {success:true}.
// CURRENT (bug): the handler reads `ctx.body.events` (the response body, which
// is undefined here), throwing "Cannot read properties of undefined".
// ---------------------------------------------------------------------------

describe('SimpleServer /feed route — HIGH-3 (reads wrong body)', () => {
	it('forwards an authorized events array to indexer.feed and returns success', async () => {
		const {httpServer, base, indexer} = await startTestServer();
		openServers.push(httpServer);

		const events = [{blockNumber: 1, foo: 'a'}, {blockNumber: 2, foo: 'b'}];
		const res = await post(base, '/feed', {events}, {authorization: API_KEY});

		expect(res.json).toEqual({success: true});
		expect(indexer.feedCalls.length).toBe(1);
		expect(indexer.feedCalls[0]).toEqual(events);
	});

	it('returns success without feeding when events array is empty', async () => {
		const {httpServer, base, indexer} = await startTestServer();
		openServers.push(httpServer);

		const res = await post(base, '/feed', {events: []}, {authorization: API_KEY});

		expect(res.json).toEqual({success: true});
		expect(indexer.feedCalls.length).toBe(0);
	});

	it('returns a shaped Bad Request error (not a 500) when events is missing/not an array', async () => {
		const {httpServer, base, indexer} = await startTestServer();
		openServers.push(httpServer);

		const res = await post(base, '/feed', {notEvents: true}, {authorization: API_KEY});

		expect(res.json).toEqual({error: {code: 4000, message: 'Bad Request: expected an `events` array.'}});
		expect(indexer.feedCalls.length).toBe(0);
	});
});
