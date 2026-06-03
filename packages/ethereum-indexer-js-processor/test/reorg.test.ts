import {describe, expect, it} from 'vitest';
import type {Abi} from 'abitype';
import type {LastSync, LogEvent} from 'ethereum-indexer';
import {fromJSProcessor, type JSProcessor} from '../src/processor/utils.js';

// ---------------------------------------------------------------------------
// CHARACTERIZATION TESTS — the live reorg / revert contract
// ---------------------------------------------------------------------------
// These tests pin the EXISTING behaviour of the JS-object processor (the path
// used in production by stratagems-world -> stratagems-snapshots). They are a
// safety net: they describe what the code does TODAY so that any later refactor
// — and in particular the planned historical-state SQLite store, whose
// `revertTo(N)` must MIRROR this revert-and-reapply behaviour — can be checked
// against the same contract.
//
// The streams fed here are shaped exactly as `generateStreamToAppend` (in the
// core package, already characterized in ethereum-indexer/test/utils.test.ts)
// emits them: a flat list of LogEvents where reorged-out events carry
// `removed: true`, followed by the canonical replacement events.
// ---------------------------------------------------------------------------

// A tiny ABI with one event: Transfer(address from, address to, uint256 id).
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

type State = {owners: {[id: string]: string}; transferCount: number};

const processor: JSProcessor<typeof abi, State> = {
	version: '1.0.0',
	construct() {
		return {owners: {}, transferCount: 0};
	},
	onTransfer(state, event) {
		state.owners[event.args.id.toString()] = event.args.to;
		state.transferCount++;
	},
};

let logCounter = 0;
// Build a Transfer LogEvent already in the "parsed" shape the processor sees.
function transfer(
	blockNumber: number,
	blockHash: string,
	args: {from: string; to: string; id: bigint},
	extra: Partial<LogEvent<typeof abi>> = {},
): LogEvent<typeof abi> {
	logCounter++;
	return {
		blockNumber,
		blockHash: blockHash as `0x${string}`,
		transactionIndex: 0,
		removed: false,
		address: '0x0000000000000000000000000000000000000000',
		data: '0x',
		topics: [],
		transactionHash: `0x${logCounter.toString(16).padStart(64, '0')}` as `0x${string}`,
		logIndex: 0,
		extra: undefined,
		eventName: 'Transfer',
		args,
		...(extra as any),
	} as unknown as LogEvent<typeof abi>;
}

const CONTEXT = {source: [{startBlock: 0, hash: 'h'}], config: 'cfg', processor: 'proc'};
function lastSync(over: Partial<LastSync<typeof abi>> = {}): LastSync<typeof abi> {
	return {
		context: CONTEXT,
		latestBlock: 0,
		lastFromBlock: 0,
		lastToBlock: 0,
		unconfirmedBlocks: [],
		...over,
	};
}

const finality = 12;

// A processor must be `load`ed before `process` (it sets `finality`). There is no
// keeper, so load just initialises internal state and returns undefined.
async function freshProcessor() {
	const p = fromJSProcessor(processor)();
	await p.load({chainId: '1', contracts: [{abi, address: '0x0000000000000000000000000000000000000000'}]} as any, {
		finality,
	});
	return p;
}

describe('JSObjectEventProcessor — apply (no reorg)', () => {
	it('applies events to state and returns the new state', async () => {
		const p = await freshProcessor();
		const state = await p.process(
			[
				transfer(100, '0xA', {from: '0x0', to: '0xalice', id: 1n}),
				transfer(101, '0xB', {from: '0xalice', to: '0xbob', id: 1n}),
			],
			// within finality window so history (revertability) is kept
			lastSync({latestBlock: 101, lastToBlock: 101}),
		);
		expect(state.owners['1']).toBe('0xbob');
		expect(state.transferCount).toBe(2);
	});
});

describe('JSObjectEventProcessor — revert (single-block reorg)', () => {
	it('reverts the reorged-out block and applies the canonical one', async () => {
		const p = await freshProcessor();

		// Block 100 (hash 0xAAA): token 1 -> alice. Within finality so it is revertable.
		let state = await p.process(
			[transfer(100, '0xAAA', {from: '0x0', to: '0xalice', id: 1n})],
			lastSync({latestBlock: 100, lastToBlock: 100}),
		);
		expect(state.owners['1']).toBe('0xalice');
		expect(state.transferCount).toBe(1);

		// Reorg: block 100 is replaced (hash 0xBBB) — token 1 now goes to carol.
		// The stream from generateStreamToAppend is: [removed(0xAAA event), new(0xBBB event)].
		const removedEvent = transfer(100, '0xAAA', {from: '0x0', to: '0xalice', id: 1n}, {removed: true});
		const newEvent = transfer(100, '0xBBB', {from: '0x0', to: '0xcarol', id: 1n});

		state = await p.process([removedEvent, newEvent], lastSync({latestBlock: 100, lastToBlock: 100}));

		// CONTRACT: the alice transfer is undone (count back to 0) then carol applied (count 1).
		expect(state.owners['1']).toBe('0xcarol');
		expect(state.transferCount).toBe(1);
	});

	it('reverting a block restores prior-block state exactly (state-as-of mirror)', async () => {
		const p = await freshProcessor();

		// Block 100: token 1 -> alice.
		await p.process(
			[transfer(100, '0xAAA', {from: '0x0', to: '0xalice', id: 1n})],
			lastSync({latestBlock: 100, lastToBlock: 100}),
		);
		// Block 101: token 1 -> bob.
		let state = await p.process(
			[transfer(101, '0xCCC', {from: '0xalice', to: '0xbob', id: 1n})],
			lastSync({latestBlock: 101, lastToBlock: 101}),
		);
		expect(state.owners['1']).toBe('0xbob');
		expect(state.transferCount).toBe(2);

		// Reorg only block 101 (0xCCC -> 0xDDD), where token 1 instead goes to dave.
		const removed101 = transfer(101, '0xCCC', {from: '0xalice', to: '0xbob', id: 1n}, {removed: true});
		const new101 = transfer(101, '0xDDD', {from: '0xalice', to: '0xdave', id: 1n});
		state = await p.process([removed101, new101], lastSync({latestBlock: 101, lastToBlock: 101}));

		// CONTRACT: state rolled back to end-of-block-100 (alice) then re-applied to dave.
		// transferCount: 2 -> (revert 101) 1 -> (apply dave) 2.
		expect(state.owners['1']).toBe('0xdave');
		expect(state.transferCount).toBe(2);
	});
});

describe('JSObjectEventProcessor — below finality (immutable window)', () => {
	it('applies confirmed events directly (no history kept, not revertable)', async () => {
		const p = await freshProcessor();
		// latestBlock - lastToBlock > finality  => willNotChange === true.
		const state = await p.process(
			[transfer(10, '0x10', {from: '0x0', to: '0xalice', id: 1n})],
			lastSync({latestBlock: 1000, lastToBlock: 1000}),
		);
		// Confirmed events still update state; they are simply not tracked for revert.
		expect(state.owners['1']).toBe('0xalice');
		expect(state.transferCount).toBe(1);
	});
});
