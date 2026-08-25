import {createClient} from '@libsql/client';
import {
	StreamBuilder,
	serializeWireBatch,
	type Abi,
	type IndexingSource,
	type LogEvent,
	type WireBatch,
} from '@etherfold/core';
import {VersionedStateEventProcessor, type EntityProcessor} from '@etherfold/processor-sqlite';
import {RemoteLibSQL} from 'remote-sql-libsql';
import type {RemoteSQL} from 'remote-sql';
import {beforeAll, describe, expect, it} from 'vitest';
import {createServer} from '../src/index.js';
import {clearLastError} from '../src/api/status.js';

// ---------------------------------------------------------------------------
// THE INGESTION ENDPOINT (ADR-0004)
// ---------------------------------------------------------------------------
// The HTTP surface where raw logs enter the indexer-server. The rules it
// enforces are the stream-builder's, and they are tested at THAT level in
// `@etherfold/core`. What is tested here is what only this layer can get wrong:
// the status codes a sender steers by, the token that guards the cursor, and the
// counters an operator watches.
//
// The whole sequence runs against a REAL processor over a REAL local libSQL
// database, because the acceptance the task states is "state and the cursor
// advance together", and a fake processor cannot fail that.
// ---------------------------------------------------------------------------

const abi = [
	{
		type: 'event',
		name: 'Transfer',
		anonymous: false,
		inputs: [
			{indexed: true, name: 'from', type: 'address'},
			{indexed: true, name: 'to', type: 'address'},
			{indexed: false, name: 'id', type: 'uint256'},
		],
	},
] as const satisfies Abi;

type TestABI = typeof abi;

const CONTRACT = '0x0000000000000000000000000000000000000099' as const;
const ALICE = '0x0000000000000000000000000000000000000011';
const BOB = '0x0000000000000000000000000000000000000022';
const CAROL = '0x0000000000000000000000000000000000000033';
const ZERO = '0x0000000000000000000000000000000000000000';

const START_BLOCK = 100;
const FINALITY = 3;
const TOKEN = 'a-shared-secret';

const SOURCE: IndexingSource<TestABI> = {
	chainId: '1',
	contracts: [{abi, address: CONTRACT, startBlock: START_BLOCK}],
};

const entityProcessor: EntityProcessor<TestABI> = {
	version: '1.0.0',
	entities: [
		{name: 'token', id: ['id'], fields: {owner: 'text'}},
		{name: 'counter', id: ['name'], fields: {value: 'integer'}},
	],
	async onTransfer(state, event) {
		state.set('token', {id: event.args.id.toString()}, {owner: event.args.to});
		const counter = await state.get<{value: number}>('counter', {name: 'transfers'});
		state.set('counter', {name: 'transfers'}, {value: (counter?.value ?? 0) + 1});
	},
};

let logCounter = 0;

function transfer(blockNumber: number, blockHash: string, to: string, id: bigint): LogEvent<TestABI> {
	logCounter++;
	return {
		blockNumber,
		blockHash: blockHash as `0x${string}`,
		blockTimestamp: 1_700_000_000 + blockNumber * 12,
		transactionIndex: 0,
		removed: false,
		address: CONTRACT,
		data: '0x',
		topics: [],
		transactionHash: `0x${logCounter.toString(16).padStart(64, '0')}` as `0x${string}`,
		logIndex: 0,
		extra: undefined,
		eventName: 'Transfer',
		args: {from: ZERO, to, id},
	} as unknown as LogEvent<TestABI>;
}

type TestEnv = {DEV?: string; INGEST_TOKEN?: string};

type Deployment = {
	app: ReturnType<typeof createServer<TestEnv>>;
	db: RemoteSQL;
	builder: StreamBuilder<TestABI, unknown>;
	processor: VersionedStateEventProcessor<TestABI>;
};

async function deploy(env: TestEnv = {INGEST_TOKEN: TOKEN}, withIngestion = true): Promise<Deployment> {
	const db: RemoteSQL = new RemoteLibSQL(createClient({url: ':memory:'}));
	const processor = new VersionedStateEventProcessor<TestABI>(db, entityProcessor);
	const builder = new StreamBuilder<TestABI, unknown>(processor, SOURCE, {stream: {finality: FINALITY}});
	const app = createServer<TestEnv>({
		getDB: () => db,
		getEnv: () => env,
		getIngestion: withIngestion ? () => builder : undefined,
	});
	// the fixed tables the counters live in; the entity tables are the store's own
	// and it creates them on its first load
	await app.request('/admin/setup', {method: 'POST'});
	return {app, db, builder, processor};
}

async function post(deployment: Deployment, batch: unknown, headers: Record<string, string> = {}): Promise<Response> {
	return deployment.app.request('/ingest', {
		method: 'POST',
		headers: {'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, ...headers},
		body: typeof batch === 'string' ? batch : serializeWireBatch(batch as WireBatch<TestABI>),
	});
}

function batchOf(
	deployment: Deployment,
	fromBlock: number,
	toBlock: number,
	latestBlock: number,
	logs: LogEvent<TestABI>[],
): WireBatch<TestABI> {
	return {context: deployment.builder.context, fromBlock, toBlock, latestBlock, logs};
}

async function ownerOf(deployment: Deployment, id: string): Promise<string | undefined> {
	return (await deployment.processor.state.getCurrent<{owner: string}>('token', {id}))?.owner;
}

async function transferCount(deployment: Deployment): Promise<number> {
	return (await deployment.processor.state.getCurrent<{value: number}>('counter', {name: 'transfers'}))?.value ?? 0;
}

async function statusOf(deployment: Deployment): Promise<any> {
	return (await deployment.app.request('/status')).json();
}

// ---------------------------------------------------------------------------

describe('the full ingestion sequence: apply, re-send, gap, mismatch, reorg', () => {
	let deployment: Deployment;

	beforeAll(async () => {
		clearLastError();
		deployment = await deploy();
	});

	it('tells a sender where to start before anything has been indexed', async () => {
		const res = await deployment.app.request('/ingest', {headers: {Authorization: `Bearer ${TOKEN}`}});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			success: true,
			expectedFromBlock: START_BLOCK,
			context: deployment.builder.context,
		});
	});

	it('applies a batch starting exactly there, advancing state and the cursor together', async () => {
		const res = await post(
			deployment,
			batchOf(deployment, 100, 105, 105, [transfer(101, '0xa101', ALICE, 1n), transfer(104, '0xa104', BOB, 2n)]),
		);

		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({
			success: true,
			applied: 2,
			retracted: 0,
			// the next batch re-scans the unconfirmed window: latestBlock - finality
			expectedFromBlock: 102,
		});
		expect(await ownerOf(deployment, '1')).toBe(ALICE);
		expect(await ownerOf(deployment, '2')).toBe(BOB);
		expect(await transferCount(deployment)).toBe(2);
	});

	it('rejects a re-sent batch with 409 and the value it expects, applying nothing', async () => {
		// the lost-acknowledgement case. The cursor IS the idempotency key: this is
		// what makes at-least-once on the wire exactly-once in effect.
		const res = await post(
			deployment,
			batchOf(deployment, 100, 105, 105, [transfer(101, '0xa101', ALICE, 1n), transfer(104, '0xa104', BOB, 2n)]),
		);

		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({
			success: false,
			error: 'unexpected-fromBlock',
			expectedFromBlock: 102,
			receivedFromBlock: 100,
		});
		// nothing double-applied
		expect(await transferCount(deployment)).toBe(2);
	});

	it('rejects a batch that skips ahead, with the same correction', async () => {
		const res = await post(deployment, batchOf(deployment, 106, 110, 110, [transfer(107, '0xa107', CAROL, 9n)]));

		expect(res.status).toBe(409);
		expect((await res.json()).expectedFromBlock).toBe(102);
		expect(await ownerOf(deployment, '9')).toBeUndefined();
		expect(await transferCount(deployment)).toBe(2);
	});

	it('rejects a batch belonging to another {source, config}, distinctly from a cursor correction', async () => {
		const foreign = {
			...batchOf(deployment, 102, 106, 106, [transfer(105, '0xa105', CAROL, 9n)]),
			context: {source: deployment.builder.context.source, config: 'someone-elses'},
		};
		const res = await post(deployment, foreign);

		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe('context-mismatch');
		// NOT the 409 a sender auto-recovers from: no block number makes this right
		expect(body.expectedFromBlock).toBeUndefined();
		expect(await ownerOf(deployment, '9')).toBeUndefined();
	});

	it('rejects a payload that is not the range it claims', async () => {
		const res = await post(deployment, batchOf(deployment, 102, 106, 106, [transfer(120, '0xa120', CAROL, 9n)]));
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe('invalid-batch');
	});

	it('derives a hash-replacement reorg itself, from raw logs with no reorg fields on the wire', async () => {
		const res = await post(deployment, batchOf(deployment, 102, 106, 106, [transfer(104, '0xb104', CAROL, 3n)]));

		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({
			success: true,
			applied: 1,
			retracted: 1,
			reorg: {cause: 'contradiction', blockNumber: 104, blockHash: '0xa104'},
			expectedFromBlock: 103,
		});
		expect(await ownerOf(deployment, '1')).toBe(ALICE); // block 101 is below the fork
		expect(await ownerOf(deployment, '2')).toBeUndefined(); // the dead branch's mint is gone
		expect(await ownerOf(deployment, '3')).toBe(CAROL);
		expect(await transferCount(deployment)).toBe(2);
	});

	it('counts a contradiction-driven revert as such, and reports it', async () => {
		const status = await statusOf(deployment);
		expect(status.reorgs).toMatchObject({contradiction: 1, absence: 0});
		expect(status.reorgs.last).toMatchObject({cause: 'contradiction', blockNumber: 104});
	});

	it('surfaces an absence-driven revert DISTINCTLY, because absence is an inference', async () => {
		// block 104 simply is not in the re-fetched range any more. That is
		// indistinguishable from a sender that under-delivered it, so it must not be
		// folded into the same line as a hash contradiction.
		const res = await post(deployment, batchOf(deployment, 103, 108, 108, []));

		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({
			applied: 0,
			retracted: 1,
			reorg: {cause: 'absence', blockNumber: 104, blockHash: '0xb104'},
		});
		expect(await ownerOf(deployment, '3')).toBeUndefined();
		expect(await transferCount(deployment)).toBe(1);
	});

	it('counts the dangerous kind separately, so a RATE of it is visible', async () => {
		const status = await statusOf(deployment);
		expect(status.reorgs).toMatchObject({absence: 1, contradiction: 1});
		expect(status.reorgs.last).toMatchObject({cause: 'absence', blockNumber: 104});
		// and the server is still healthy: an absence-driven revert is a signal, not a fault
		expect(status.healthy).toBe(true);
	});

	it('ends with the cursor the last accepted batch left, and no other', async () => {
		const res = await deployment.app.request('/ingest', {headers: {Authorization: `Bearer ${TOKEN}`}});
		expect((await res.json()).expectedFromBlock).toBe(105);
	});
});

describe('the endpoint requires authentication', () => {
	it('refuses an unauthenticated caller, and the cursor does not move', async () => {
		const deployment = await deploy();
		const batch = batchOf(deployment, 100, 105, 105, [transfer(101, '0xa101', ALICE, 1n)]);

		const res = await deployment.app.request('/ingest', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: serializeWireBatch(batch),
		});

		expect(res.status).toBe(401);
		expect((await res.json()).error).toBe('unauthorized');
		expect(await deployment.builder.expectedFromBlock()).toBe(START_BLOCK);
		expect(await ownerOf(deployment, '1')).toBeUndefined();
	});

	it('refuses the wrong token', async () => {
		const deployment = await deploy();
		const res = await post(deployment, batchOf(deployment, 100, 105, 105, []), {
			Authorization: `Bearer not-the-token`,
		});
		expect(res.status).toBe(401);
		expect(await deployment.builder.expectedFromBlock()).toBe(START_BLOCK);
	});

	it('refuses everyone when no token is configured, rather than letting everyone in', async () => {
		// fail CLOSED. The old server generated a key and printed it to stdout,
		// which is a server that is "secured" by a line in a log file.
		const deployment = await deploy({});
		const res = await post(deployment, batchOf(deployment, 100, 105, 105, []));
		expect(res.status).toBe(401);
		expect((await res.json()).message).toMatch(/INGEST_TOKEN/);
		expect(await deployment.builder.expectedFromBlock()).toBe(START_BLOCK);
	});

	it('guards the cursor READ as well, since it is the fetcher-facing surface', async () => {
		const deployment = await deploy();
		expect((await deployment.app.request('/ingest')).status).toBe(401);
	});
});

describe('a server hosting no processor', () => {
	it('says so instead of pretending to have a cursor', async () => {
		const deployment = await deploy({INGEST_TOKEN: TOKEN}, false);

		const get = await deployment.app.request('/ingest', {headers: {Authorization: `Bearer ${TOKEN}`}});
		expect(get.status).toBe(501);
		expect((await get.json()).error).toBe('ingestion-not-configured');

		const posted = await post(deployment, batchOf(deployment, 100, 105, 105, []));
		expect(posted.status).toBe(501);
	});

	it('still refuses an unauthenticated caller first, so the absence is not a probe', async () => {
		const deployment = await deploy({INGEST_TOKEN: TOKEN}, false);
		expect((await deployment.app.request('/ingest')).status).toBe(401);
	});
});

describe('the body must be a batch', () => {
	it('rejects a body that is not JSON', async () => {
		const deployment = await deploy();
		const res = await post(deployment, 'not json at all');
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe('invalid-json');
	});

	it('carries BigInt event arguments across intact', async () => {
		const deployment = await deploy();
		const id = 2n ** 200n;
		const res = await post(deployment, batchOf(deployment, 100, 105, 105, [transfer(101, '0xa101', ALICE, id)]));
		expect(res.status).toBe(200);
		expect(await ownerOf(deployment, id.toString())).toBe(ALICE);
	});
});
