import {describe, expect, it} from 'vitest';
import {rows} from './utils/db.js';
import {freshProcessor, lastSync, ownerOf, transfer, transferCount} from './utils/fixtures.js';

// ---------------------------------------------------------------------------
// The d24872f case, one layer down
// ---------------------------------------------------------------------------
// On 2026-08-21 the engine was fixed for a reorg that REMOVES a block's logs
// without replacing them at another block-with-logs: the transaction went back
// to the mempool and was not re-mined, so the re-fetch legitimately returns a
// SHORTER list and the vanished block was never compared with anything. No
// `removed: true` was emitted, the block lingered in unconfirmedBlocks until
// finality pruned it, and the corruption was permanent. Low-traffic sources were
// the most exposed, because the bug self-healed only if another block WITH logs
// happened to land in the unconfirmed window first.
//
// The engine now emits the retraction (pinned in
// `core/test/utils.test.ts`: "detects a reorg when a trailing
// unconfirmed block vanishes from the re-fetch"). What is pinned HERE is that
// this processor acts on it. A revert wired to "a new hash appeared at this
// height" would reproduce the same bug in the database, where the symptom is a
// stale row nobody looks at rather than a state object somebody prints.
//
// The streams below are shaped exactly as `generateStreamToAppend` emits them
// for those scenarios: retractions only, with NO canonical replacement.
// ---------------------------------------------------------------------------

describe('VersionedStateEventProcessor — reorg that removes logs with no replacement', () => {
	it('retracts a vanished trailing block, leaving the untouched earlier block alone', async () => {
		const {p} = await freshProcessor();

		// Block 100 keeps token 1; block 105 moves token 2. Both unconfirmed.
		await p.process(
			[transfer(100, '0xAAA', {from: '0x0', to: '0xalice', id: 1n})],
			lastSync({latestBlock: 100, lastToBlock: 100}),
		);
		await p.process(
			[transfer(105, '0xBBB', {from: '0x0', to: '0xbob', id: 2n})],
			lastSync({latestBlock: 105, lastToBlock: 105}),
		);
		expect(await ownerOf(p, '2')).toBe('0xbob');
		expect(await transferCount(p)).toBe(2);

		// Block 105 is reorged out and its log is NOT re-mined anywhere. The engine
		// emits the retraction alone: there is no replacement event to follow it.
		await p.process(
			[transfer(105, '0xBBB', {from: '0x0', to: '0xbob', id: 2n}, {removed: true})],
			lastSync({latestBlock: 106, lastToBlock: 106}),
		);

		// The vanished block's effect is gone...
		expect(await ownerOf(p, '2')).toBeUndefined();
		expect(await transferCount(p)).toBe(1);
		// ...and block 100, which the reorg never touched, is untouched.
		expect(await ownerOf(p, '1')).toBe('0xalice');
	});

	it('stops resolving the reorged-out hash, so a consumer pinned to it is told', async () => {
		const {p} = await freshProcessor();
		await p.process(
			[transfer(105, '0xBBB', {from: '0x0', to: '0xbob', id: 2n})],
			lastSync({latestBlock: 105, lastToBlock: 105}),
		);
		expect(await p.state.resolveBlockNumber({hash: '0xBBB'})).toBe(105);

		await p.process(
			[transfer(105, '0xBBB', {from: '0x0', to: '0xbob', id: 2n}, {removed: true})],
			lastSync({latestBlock: 106, lastToBlock: 106}),
		);

		// ADR-0015: the pinned hash answering "no such block" IS the reorg signal.
		expect(await p.state.resolveBlockNumber({hash: '0xBBB'})).toBeUndefined();
		await expect(p.state.getAsOf('token', {id: '2'}, {hash: '0xBBB'})).rejects.toThrow(/no such block/);
	});

	it('retracts every vanished block when the whole unconfirmed window disappears', async () => {
		const {db, p} = await freshProcessor();

		await p.process(
			[transfer(100, '0xAAA', {from: '0x0', to: '0xalice', id: 1n})],
			lastSync({latestBlock: 100, lastToBlock: 100}),
		);
		await p.process(
			[transfer(101, '0xBBB', {from: '0x0', to: '0xbob', id: 2n})],
			lastSync({latestBlock: 101, lastToBlock: 101}),
		);

		// Both blocks vanish: the engine emits both retractions, lowest first.
		await p.process(
			[
				transfer(100, '0xAAA', {from: '0x0', to: '0xalice', id: 1n}, {removed: true}),
				transfer(101, '0xBBB', {from: '0x0', to: '0xbob', id: 2n}, {removed: true}),
			],
			lastSync({latestBlock: 102, lastToBlock: 102}),
		);

		expect(await ownerOf(p, '1')).toBeUndefined();
		expect(await ownerOf(p, '2')).toBeUndefined();
		expect(await transferCount(p)).toBe(0);
		expect(await rows(db, `SELECT number FROM _blocks`)).toEqual([]);
	});

	it('reverts ONCE to the lowest retracted block, whatever order the retractions arrive in', async () => {
		const {p} = await freshProcessor();
		await p.process(
			[transfer(100, '0xAAA', {from: '0x0', to: '0xalice', id: 1n})],
			lastSync({latestBlock: 100, lastToBlock: 100}),
		);
		await p.process(
			[transfer(101, '0xBBB', {from: '0xalice', to: '0xbob', id: 1n})],
			lastSync({latestBlock: 101, lastToBlock: 101}),
		);

		// Deliberately highest-first. A revert driven by the FIRST removed event
		// would keep block 100's dead version live; the fork point is a min over
		// the whole stream, so it does not.
		await p.process(
			[
				transfer(101, '0xBBB', {from: '0xalice', to: '0xbob', id: 1n}, {removed: true}),
				transfer(100, '0xAAA', {from: '0x0', to: '0xalice', id: 1n}, {removed: true}),
			],
			lastSync({latestBlock: 102, lastToBlock: 102}),
		);

		expect(await ownerOf(p, '1')).toBeUndefined();
		expect(await transferCount(p)).toBe(0);
	});
});
