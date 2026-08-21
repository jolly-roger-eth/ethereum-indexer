import {describe, expect, it} from 'vitest';
import {freshProcessor, lastSync, ownerOf, transfer, transferCount} from './utils/fixtures.js';

// ---------------------------------------------------------------------------
// EQUIVALENCE TESTS — the SQL path against the live path's pinned contract
// ---------------------------------------------------------------------------
// Every `describe` below is a port of the same-named block in
// `packages/ethereum-indexer-js-processor/test/reorg.test.ts`, running the SAME
// streams and asserting the SAME numbers. The in-memory tests are the
// characterization of what the production path does; these are the check that
// the database path does it too.
//
// That is why the assertions quote the in-memory values (`0xcarol`, count 1,
// count 2) rather than values derived from what this implementation happens to
// write: divergence between the two paths has to be a test failure here, not a
// discovery in production. If a scenario is changed in one file it must be
// changed in the other, and the header of that file says so as well.
//
// `state.owners[id]` is the `token` table and `state.transferCount` is one row
// of `counter`; `ownerOf` / `transferCount` do that translation so the
// expectations stay literally comparable.
// ---------------------------------------------------------------------------

describe('VersionedStateEventProcessor — apply (no reorg)', () => {
	it('applies events to state and returns the new state', async () => {
		const {p} = await freshProcessor();
		const state = await p.process(
			[
				transfer(100, '0xA', {from: '0x0', to: '0xalice', id: 1n}),
				transfer(101, '0xB', {from: '0xalice', to: '0xbob', id: 1n}),
			],
			// within finality window so history (revertability) is kept
			lastSync({latestBlock: 101, lastToBlock: 101}),
		);
		expect((await state.getCurrent<{owner: string}>('token', {id: '1'}))?.owner).toBe('0xbob');
		expect(await transferCount(p)).toBe(2);
	});

	it('applies several events of one block as one block', async () => {
		const {p} = await freshProcessor();
		await p.process(
			[
				transfer(100, '0xA', {from: '0x0', to: '0xalice', id: 1n}),
				transfer(100, '0xA', {from: '0xalice', to: '0xbob', id: 1n}),
			],
			lastSync({latestBlock: 100, lastToBlock: 100}),
		);
		expect(await ownerOf(p, '1')).toBe('0xbob');
		// read-your-writes within the block: the second handler saw the first's counter
		expect(await transferCount(p)).toBe(2);
	});
});

describe('VersionedStateEventProcessor — revert (single-block reorg)', () => {
	it('reverts the reorged-out block and applies the canonical one', async () => {
		const {p} = await freshProcessor();

		// Block 100 (hash 0xAAA): token 1 -> alice. Within finality so it is revertable.
		await p.process(
			[transfer(100, '0xAAA', {from: '0x0', to: '0xalice', id: 1n})],
			lastSync({latestBlock: 100, lastToBlock: 100}),
		);
		expect(await ownerOf(p, '1')).toBe('0xalice');
		expect(await transferCount(p)).toBe(1);

		// Reorg: block 100 is replaced (hash 0xBBB) — token 1 now goes to carol.
		// The stream from generateStreamToAppend is: [removed(0xAAA event), new(0xBBB event)].
		const removedEvent = transfer(100, '0xAAA', {from: '0x0', to: '0xalice', id: 1n}, {removed: true});
		const newEvent = transfer(100, '0xBBB', {from: '0x0', to: '0xcarol', id: 1n});

		await p.process([removedEvent, newEvent], lastSync({latestBlock: 100, lastToBlock: 100}));

		// CONTRACT: the alice transfer is undone (count back to 0) then carol applied (count 1).
		expect(await ownerOf(p, '1')).toBe('0xcarol');
		expect(await transferCount(p)).toBe(1);
	});

	it('reverting a block restores prior-block state exactly (state-as-of mirror)', async () => {
		const {p} = await freshProcessor();

		// Block 100: token 1 -> alice.
		await p.process(
			[transfer(100, '0xAAA', {from: '0x0', to: '0xalice', id: 1n})],
			lastSync({latestBlock: 100, lastToBlock: 100}),
		);
		// Block 101: token 1 -> bob.
		await p.process(
			[transfer(101, '0xCCC', {from: '0xalice', to: '0xbob', id: 1n})],
			lastSync({latestBlock: 101, lastToBlock: 101}),
		);
		expect(await ownerOf(p, '1')).toBe('0xbob');
		expect(await transferCount(p)).toBe(2);

		// Reorg only block 101 (0xCCC -> 0xDDD), where token 1 instead goes to dave.
		const removed101 = transfer(101, '0xCCC', {from: '0xalice', to: '0xbob', id: 1n}, {removed: true});
		const new101 = transfer(101, '0xDDD', {from: '0xalice', to: '0xdave', id: 1n});
		await p.process([removed101, new101], lastSync({latestBlock: 101, lastToBlock: 101}));

		// CONTRACT: state rolled back to end-of-block-100 (alice) then re-applied to dave.
		// transferCount: 2 -> (revert 101) 1 -> (apply dave) 2.
		expect(await ownerOf(p, '1')).toBe('0xdave');
		expect(await transferCount(p)).toBe(2);
	});
});

describe('VersionedStateEventProcessor — below finality (immutable window)', () => {
	it('applies confirmed events directly (no history kept, not revertable)', async () => {
		const {p} = await freshProcessor();
		// latestBlock - lastToBlock > finality  => willNotChange === true.
		await p.process(
			[transfer(10, '0x10', {from: '0x0', to: '0xalice', id: 1n})],
			lastSync({latestBlock: 1000, lastToBlock: 1000}),
		);
		// Confirmed events still update state; they are simply not tracked for revert.
		expect(await ownerOf(p, '1')).toBe('0xalice');
		expect(await transferCount(p)).toBe(1);
	});
});
