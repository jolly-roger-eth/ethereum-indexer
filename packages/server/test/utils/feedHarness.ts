import {createClient} from '@libsql/client';
import {
	StreamBuilder,
	resolveStreamConfig,
	serializeWireBatch,
	streamDigestOf,
	type Abi,
	type IndexingSource,
	type LogEvent,
	type WireBatch,
} from '@etherfold/core';
import {VersionedStateEventProcessor, type EntityProcessor} from '@etherfold/processor-sqlite';
import {RemoteLibSQL} from 'remote-sql-libsql';
import type {RemoteSQL} from 'remote-sql';
import {expect} from 'vitest';
import {createServer, indexerRegistry} from '../../src/index.js';

// ---------------------------------------------------------------------------
// THE FIXTURE BOTH VIEWS ARE ASSERTED THROUGH
// ---------------------------------------------------------------------------
// One deployment builder, one real ingest push, one batch helper -- shared,
// because ADR-0006's two views read ONE table and an assertion about either is
// only worth something if it was reached the way a batch actually arrives:
// through `/{indexer}/ingest`, so the stream-builder derives its own reorgs and
// the route writes the rows. A second copy of this harness in the second view's
// file would be a second definition of what "a reorg" means in a test, and the
// two would drift.
// ---------------------------------------------------------------------------

export const abi = [
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

export type TestABI = typeof abi;

export const CONTRACT = '0x0000000000000000000000000000000000000099' as const;
/** A DIFFERENT fetch filter, and therefore a different STREAM. */
export const OTHER_CONTRACT = '0x0000000000000000000000000000000000000077' as const;
export const ALICE = '0x0000000000000000000000000000000000000011';
export const BOB = '0x0000000000000000000000000000000000000022';
export const CAROL = '0x0000000000000000000000000000000000000033';
export const ZERO = '0x0000000000000000000000000000000000000000';

export const TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as const;

export const START_BLOCK = 100;
export const FINALITY = 3;
export const TOKEN = 'a-shared-secret';

export const SOURCE: IndexingSource<TestABI> = {
	chainId: '1',
	contracts: [{abi, address: CONTRACT, startBlock: START_BLOCK}],
};

/** Byte-identical to `SOURCE`: the same STREAM under a different NAME. */
export const IDENTICAL_SOURCE: IndexingSource<TestABI> = {
	chainId: '1',
	contracts: [{abi, address: CONTRACT, startBlock: START_BLOCK}],
};

/** Another address, so `streamDigestOf` moves: this is a new stream, not a fork. */
export const RECONFIGURED_SOURCE: IndexingSource<TestABI> = {
	chainId: '1',
	contracts: [{abi, address: OTHER_CONTRACT, startBlock: START_BLOCK}],
};

export const STREAM_CONFIG = {finality: FINALITY};

export const STREAM_DIGEST = streamDigestOf(SOURCE, resolveStreamConfig(STREAM_CONFIG));
export const RECONFIGURED_DIGEST = streamDigestOf(RECONFIGURED_SOURCE, resolveStreamConfig(STREAM_CONFIG));

const entityProcessor: EntityProcessor<TestABI> = {
	version: '1.0.0',
	entities: [{name: 'token', id: ['id'], fields: {owner: 'text'}}],
	async onTransfer(state, event) {
		state.set('token', {id: (event.args as {id: bigint}).id.toString()}, {owner: event.args.to});
	},
};

let logCounter = 0;

export function transfer(
	blockNumber: number,
	blockHash: string,
	to: string,
	id: bigint,
	logIndex = 0,
	address: string = CONTRACT,
): LogEvent<TestABI> {
	logCounter++;
	return {
		blockNumber,
		blockHash: blockHash as `0x${string}`,
		blockTimestamp: 1_700_000_000 + blockNumber * 12,
		transactionIndex: 0,
		removed: false,
		address,
		data: `0x${id.toString(16).padStart(64, '0')}`,
		topics: [TRANSFER_TOPIC0, pad(ZERO), pad(to)],
		transactionHash: `0x${logCounter.toString(16).padStart(64, '0')}` as `0x${string}`,
		logIndex,
		extra: undefined,
		eventName: 'Transfer',
		args: {from: ZERO, to, id},
	} as unknown as LogEvent<TestABI>;
}

export function pad(address: string): `0x${string}` {
	return `0x${address.slice(2).padStart(64, '0')}` as `0x${string}`;
}

export type TestEnv = {DEV?: string; INGEST_TOKEN?: string};

type Hosted = {builder: StreamBuilder<TestABI, unknown>};

export type Deployment = {
	app: ReturnType<typeof createServer<TestEnv>>;
	db: RemoteSQL;
	hosted: Record<string, Hosted>;
};

/** A host built with several named indexers over ONE database. */
export async function deploy(sources: Record<string, IndexingSource<TestABI>>, db?: RemoteSQL): Promise<Deployment> {
	const database: RemoteSQL = db ?? new RemoteLibSQL(createClient({url: ':memory:'}));
	const hosted: Record<string, Hosted> = {};
	const ingestions: Record<string, StreamBuilder<TestABI, unknown>> = {};
	for (const [name, source] of Object.entries(sources)) {
		const processor = new VersionedStateEventProcessor<TestABI>(
			new RemoteLibSQL(createClient({url: ':memory:'})),
			entityProcessor,
		);
		const builder = new StreamBuilder<TestABI, unknown>(processor, source, {stream: STREAM_CONFIG});
		hosted[name] = {builder};
		ingestions[name] = builder;
	}
	const app = createServer<TestEnv>({
		getDB: () => database,
		getEnv: () => ({INGEST_TOKEN: TOKEN}),
		getIndexer: indexerRegistry(ingestions),
	});
	await app.request('/admin/setup', {method: 'POST'});
	return {app, db: database, hosted};
}

/**
 * Push a batch, and REFUSE to carry on if it was not accepted.
 *
 * Every batch in these files is meant to land: a `409` correction here would
 * leave the table short and make a feed assertion fail somewhere far away,
 * describing the wrong problem.
 */
export async function post(deployment: Deployment, name: string, batch: WireBatch<TestABI>): Promise<void> {
	const res = await deployment.app.request(`/${name}/ingest`, {
		method: 'POST',
		headers: {'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`},
		body: serializeWireBatch(batch),
	});
	expect(res.status, `pushing to ${name}: ${await res.clone().text()}`).toBe(200);
}

export function batchOf(
	deployment: Deployment,
	name: string,
	fromBlock: number,
	toBlock: number,
	latestBlock: number,
	logs: LogEvent<TestABI>[],
): WireBatch<TestABI> {
	return {context: (deployment.hosted[name] as Hosted).builder.context, fromBlock, toBlock, latestBlock, logs};
}
