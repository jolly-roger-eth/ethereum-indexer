import {fromJSProcessor, type JSProcessor} from 'ethereum-indexer-js-processor';
import type {LastSync, LogEvent} from 'ethereum-indexer';
import {describe, expect, it} from 'vitest';
import {finality, freshProcessor, lastSync, SOURCE, transfer, type TestABI} from './utils/fixtures.js';

// ---------------------------------------------------------------------------
// DIFFERENTIAL EQUIVALENCE — both processors, one stream, one comparison
// ---------------------------------------------------------------------------
// `reorg.test.ts` mirrors the in-memory scenarios by quoting their expected
// values. This file removes the transcription step entirely: it runs the SAME
// stream through the REAL `JSObjectEventProcessor` and through the SQL
// processor, and compares the two resulting states directly.
//
// That is what makes divergence a test failure rather than a discovery. A change
// to either path that alters observable state fails here even if nobody thought
// to update an expected number, and the failure names both sides.
//
// The two states are projected to one comparable shape
// (`{owners, transferCount}`), which is the shape the in-memory path holds
// natively and the shape the versioned tables were declared to mirror.
// ---------------------------------------------------------------------------

type State = {owners: {[id: string]: string}; transferCount: number};

const jsProcessor: JSProcessor<TestABI, State> = {
	version: '1.0.0',
	construct() {
		return {owners: {}, transferCount: 0};
	},
	onTransfer(state, event) {
		state.owners[event.args.id.toString()] = event.args.to;
		state.transferCount++;
	},
};

type Round = {stream: LogEvent<TestABI>[]; lastSync: LastSync<TestABI>};

/** Run both processors over the same rounds and return both final states. */
async function runBoth(rounds: Round[]): Promise<{inMemory: State; sql: State}> {
	const js = fromJSProcessor(jsProcessor)();
	await js.load(SOURCE, {finality});
	const {p: sql} = await freshProcessor();

	let inMemory: State = {owners: {}, transferCount: 0};
	for (const round of rounds) {
		inMemory = await js.process(round.stream, round.lastSync);
		await sql.process(round.stream, round.lastSync);
	}

	const tokens = await sql.state.queryCurrent<{id: string; owner: string}>('token');
	const counter = await sql.state.getCurrent<{value: number}>('counter', {name: 'transfers'});
	return {
		inMemory,
		sql: {
			owners: Object.fromEntries(tokens.map((token) => [token.id, token.owner])),
			transferCount: counter?.value ?? 0,
		},
	};
}

async function expectSameState(rounds: Round[]): Promise<State> {
	const {inMemory, sql} = await runBoth(rounds);
	expect(sql.owners).toEqual(inMemory.owners);
	expect(sql.transferCount).toBe(inMemory.transferCount);
	return inMemory;
}

describe('the SQL path reaches the same state as the live in-memory path', () => {
	it('applying a clean stream', async () => {
		const state = await expectSameState([
			{
				stream: [
					transfer(100, '0xA', {from: '0x0', to: '0xalice', id: 1n}),
					transfer(101, '0xB', {from: '0xalice', to: '0xbob', id: 1n}),
				],
				lastSync: lastSync({latestBlock: 101, lastToBlock: 101}),
			},
		]);
		// guard against both paths being trivially empty and "agreeing"
		expect(state.transferCount).toBe(2);
	});

	it('a single-block reorg (same height, new hash)', async () => {
		const state = await expectSameState([
			{
				stream: [transfer(100, '0xAAA', {from: '0x0', to: '0xalice', id: 1n})],
				lastSync: lastSync({latestBlock: 100, lastToBlock: 100}),
			},
			{
				stream: [
					transfer(100, '0xAAA', {from: '0x0', to: '0xalice', id: 1n}, {removed: true}),
					transfer(100, '0xBBB', {from: '0x0', to: '0xcarol', id: 1n}),
				],
				lastSync: lastSync({latestBlock: 100, lastToBlock: 100}),
			},
		]);
		expect(state.owners['1']).toBe('0xcarol');
		expect(state.transferCount).toBe(1);
	});

	it('a reorg of the trailing block, with entities the reorg never touched', async () => {
		const state = await expectSameState([
			{
				stream: [transfer(100, '0xAAA', {from: '0x0', to: '0xalice', id: 1n})],
				lastSync: lastSync({latestBlock: 100, lastToBlock: 100}),
			},
			{
				stream: [transfer(101, '0xCCC', {from: '0x0', to: '0xbob', id: 2n})],
				lastSync: lastSync({latestBlock: 101, lastToBlock: 101}),
			},
			{
				stream: [
					transfer(101, '0xCCC', {from: '0x0', to: '0xbob', id: 2n}, {removed: true}),
					transfer(101, '0xDDD', {from: '0x0', to: '0xdave', id: 2n}),
				],
				lastSync: lastSync({latestBlock: 101, lastToBlock: 101}),
			},
		]);
		// token 1 was never in the reorged block and must survive it in both paths
		expect(state.owners['1']).toBe('0xalice');
		expect(state.owners['2']).toBe('0xdave');
		expect(state.transferCount).toBe(2);
	});

	it('a reorg that removes a block with NO replacement (the d24872f case)', async () => {
		const state = await expectSameState([
			{
				stream: [transfer(100, '0xAAA', {from: '0x0', to: '0xalice', id: 1n})],
				lastSync: lastSync({latestBlock: 100, lastToBlock: 100}),
			},
			{
				stream: [transfer(105, '0xBBB', {from: '0x0', to: '0xbob', id: 2n})],
				lastSync: lastSync({latestBlock: 105, lastToBlock: 105}),
			},
			{
				stream: [transfer(105, '0xBBB', {from: '0x0', to: '0xbob', id: 2n}, {removed: true})],
				lastSync: lastSync({latestBlock: 106, lastToBlock: 106}),
			},
		]);
		expect(state.owners['2']).toBeUndefined();
		expect(state.owners['1']).toBe('0xalice');
		expect(state.transferCount).toBe(1);
	});

	it('several events in one block, and several blocks in one call', async () => {
		const state = await expectSameState([
			{
				stream: [
					transfer(100, '0xA', {from: '0x0', to: '0xalice', id: 1n}),
					transfer(100, '0xA', {from: '0xalice', to: '0xbob', id: 1n}),
					transfer(100, '0xA', {from: '0x0', to: '0xzoe', id: 2n}),
					transfer(101, '0xB', {from: '0xbob', to: '0xcarol', id: 1n}),
				],
				lastSync: lastSync({latestBlock: 101, lastToBlock: 101}),
			},
		]);
		expect(state.transferCount).toBe(4);
		expect(state.owners).toEqual({'1': '0xcarol', '2': '0xzoe'});
	});

	it('below the finality window, where events are applied but never retracted', async () => {
		const state = await expectSameState([
			{
				stream: [transfer(10, '0x10', {from: '0x0', to: '0xalice', id: 1n})],
				lastSync: lastSync({latestBlock: 1000, lastToBlock: 1000}),
			},
		]);
		expect(state.owners['1']).toBe('0xalice');
		expect(state.transferCount).toBe(1);
	});
});
