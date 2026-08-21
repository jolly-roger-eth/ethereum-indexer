import {describe, expect, it} from 'vitest';
import {freshProcessor, lastSync, timestampOf, transfer} from './utils/fixtures.js';

// The whole point of the exercise: indexing normally leaves the state readable
// as of any earlier block, on all three axes, without the processor author doing
// anything beyond declaring entities and writing handlers.

async function indexedRange() {
	const {db, p} = await freshProcessor();
	await p.process(
		[transfer(100, '0xAAA', {from: '0x0', to: '0xalice', id: 1n})],
		lastSync({latestBlock: 100, lastToBlock: 100}),
	);
	await p.process(
		[transfer(101, '0xBBB', {from: '0xalice', to: '0xbob', id: 1n})],
		lastSync({latestBlock: 101, lastToBlock: 101}),
	);
	await p.process(
		[transfer(102, '0xCCC', {from: '0xbob', to: '0xcarol', id: 1n})],
		lastSync({latestBlock: 102, lastToBlock: 102}),
	);
	return {db, p};
}

describe('state as of an earlier block, after ordinary indexing', () => {
	it('answers each block with the state that block ended on', async () => {
		const {p} = await indexedRange();
		expect((await p.state.getAsOf<{owner: string}>('token', {id: '1'}, 100))?.owner).toBe('0xalice');
		expect((await p.state.getAsOf<{owner: string}>('token', {id: '1'}, 101))?.owner).toBe('0xbob');
		expect((await p.state.getAsOf<{owner: string}>('token', {id: '1'}, 102))?.owner).toBe('0xcarol');
		expect((await p.state.getCurrent<{owner: string}>('token', {id: '1'}))?.owner).toBe('0xcarol');
	});

	it('answers "absent" below the first block that created the entity', async () => {
		const {p} = await indexedRange();
		// A known-shaped answer, not a throw: block 99 is a valid point on the ranges.
		expect(await p.state.getAsOf('token', {id: '1'}, 99)).toBeUndefined();
	});

	it('counts as of each block too, so a whole-state read is consistent', async () => {
		const {p} = await indexedRange();
		expect((await p.state.getAsOf<{value: number}>('counter', {name: 'transfers'}, 100))?.value).toBe(1);
		expect((await p.state.getAsOf<{value: number}>('counter', {name: 'transfers'}, 101))?.value).toBe(2);
		expect((await p.state.getAsOf<{value: number}>('counter', {name: 'transfers'}, 102))?.value).toBe(3);
	});

	it('addresses the same state by hash and by time, not only by height', async () => {
		const {p} = await indexedRange();
		expect((await p.state.getAsOf<{owner: string}>('token', {id: '1'}, {hash: '0xBBB'}))?.owner).toBe('0xbob');
		// hashes are folded to lower case on write and lookup, so an echoed-back
		// upper-case hash must not read as a reorg (ADR-0015)
		expect((await p.state.getAsOf<{owner: string}>('token', {id: '1'}, {hash: '0xBBB'.toUpperCase()}))?.owner).toBe(
			'0xbob',
		);
		expect((await p.state.getAsOf<{owner: string}>('token', {id: '1'}, {timestamp: timestampOf(101) + 5}))?.owner).toBe(
			'0xbob',
		);
	});

	it('records the block timestamps the events carried, not a guess', async () => {
		const {p} = await indexedRange();
		expect(await p.state.getBlock({hash: '0xCCC'})).toMatchObject({
			number: 102,
			hash: '0xccc',
			timestamp: timestampOf(102),
		});
	});

	it('keeps history below a fork fully time-travellable after a revert', async () => {
		const {p} = await indexedRange();
		await p.process(
			[
				transfer(102, '0xCCC', {from: '0xbob', to: '0xcarol', id: 1n}, {removed: true}),
				transfer(102, '0xDDD', {from: '0xbob', to: '0xdave', id: 1n}),
			],
			lastSync({latestBlock: 102, lastToBlock: 102}),
		);
		expect((await p.state.getCurrent<{owner: string}>('token', {id: '1'}))?.owner).toBe('0xdave');
		// the pre-fork history is untouched
		expect((await p.state.getAsOf<{owner: string}>('token', {id: '1'}, 100))?.owner).toBe('0xalice');
		expect((await p.state.getAsOf<{owner: string}>('token', {id: '1'}, 101))?.owner).toBe('0xbob');
		// and the dead branch's block is not addressable any more
		expect(await p.state.resolveBlockNumber({hash: '0xCCC'})).toBeUndefined();
	});
});
