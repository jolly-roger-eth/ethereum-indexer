import {beforeEach, describe, expect, it} from 'vitest';
import {NoSuchBlockError, VersionedStateStore} from '../src/index.js';
import {createTestDB, rows} from './utils/db.js';
import {TOKEN, block, owns} from './utils/fixtures.js';

// One token, three owners, one block each:
//   [100, 101) Alice   [101, 102) Bob   [102, ...) Carol
// `block(n)` gives hash `0x<n in hex>` and timestamp 1_700_000_000 + 12n.
async function threeVersions() {
	const db = createTestDB();
	const store = new VersionedStateStore(db, [TOKEN]);
	await store.migrate();
	await store.applyBlock(block(100), [owns('1', '0xAlice', 1)]);
	await store.applyBlock(block(101), [owns('1', '0xBob', 2)]);
	await store.applyBlock(block(102), [owns('1', '0xCarol', 3)]);
	return {db, store};
}

const owner = (row: {owner: string} | undefined) => row?.owner;

describe('the three query axes', () => {
	let store: VersionedStateStore;

	beforeEach(async () => {
		({store} = await threeVersions());
	});

	it('return identical results when they identify the same block', async () => {
		const {number, hash, timestamp} = block(101);

		const byHeight = await store.getAsOf<{owner: string}>('token', {id: '1'}, number);
		const byShorthand = await store.getAsOf<{owner: string}>('token', {id: '1'}, {number});
		const byHash = await store.getAsOf<{owner: string}>('token', {id: '1'}, {hash});
		const byTime = await store.getAsOf<{owner: string}>('token', {id: '1'}, {timestamp});

		expect(owner(byHeight)).toBe('0xBob');
		expect(byShorthand).toEqual(byHeight);
		expect(byHash).toEqual(byHeight);
		expect(byTime).toEqual(byHeight);
	});

	it('agree on a whole-table query too', async () => {
		await store.applyBlock(block(103), [owns('2', '0xDave', 1)]);
		const {hash, timestamp} = block(102);

		const byHeight = await store.queryAsOf<{id: string}>('token', 102);
		expect(byHeight.map((t) => t.id)).toEqual(['1']);
		expect(await store.queryAsOf<{id: string}>('token', {hash})).toEqual(byHeight);
		expect(await store.queryAsOf<{id: string}>('token', {timestamp})).toEqual(byHeight);
	});

	it('all resolve to a block number, which is what the reads are keyed on', async () => {
		expect(await store.resolveBlockNumber(101)).toBe(101);
		expect(await store.resolveBlockNumber({number: 101})).toBe(101);
		expect(await store.resolveBlockNumber({hash: block(101).hash})).toBe(101);
		expect(await store.resolveBlockNumber({timestamp: block(101).timestamp})).toBe(101);
	});
});

describe('addressing by hash', () => {
	it('is answered "no such block" when the hash is unknown, distinguishably from an absent entity', async () => {
		const {store} = await threeVersions();

		// block known, entity absent: an ordinary answer
		expect(await store.getAsOf('token', {id: 'never-minted'}, {hash: block(101).hash})).toBeUndefined();

		// block unknown: NOT an ordinary answer. Whatever the consumer pinned is invalid.
		await expect(store.getAsOf('token', {id: '1'}, {hash: '0xdeadbeef'})).rejects.toThrow(NoSuchBlockError);
		expect(await store.resolveBlockNumber({hash: '0xdeadbeef'})).toBeUndefined();
	});

	it('carries the reason on the error, so the caller can tell the two unresolvable cases apart', async () => {
		const {store} = await threeVersions();
		const error = await store.getAsOf('token', {id: '1'}, {hash: '0xdeadbeef'}).catch((e) => e);
		expect(error).toBeInstanceOf(NoSuchBlockError);
		expect(error.reason).toBe('unknown-hash');
		expect(error.address).toEqual({hash: '0xdeadbeef'});
	});

	it('stops resolving once the block has been reverted out', async () => {
		const {store} = await threeVersions();
		const reorged = block(102).hash;
		expect(await store.resolveBlockNumber({hash: reorged})).toBe(102);

		await store.revertTo(101);

		expect(await store.resolveBlockNumber({hash: reorged})).toBeUndefined();
		await expect(store.getAsOf('token', {id: '1'}, {hash: reorged})).rejects.toThrow(NoSuchBlockError);
		// the surviving branch still resolves, and reads as of it
		expect(await store.resolveBlockNumber({hash: block(101).hash})).toBe(101);
		expect(owner(await store.getAsOf<{owner: string}>('token', {id: '1'}, {hash: block(101).hash}))).toBe('0xBob');
	});

	it('is not case-sensitive, so an echoed-back hash cannot masquerade as a reorg', async () => {
		const db = createTestDB();
		const store = new VersionedStateStore(db, [TOKEN]);
		await store.migrate();
		await store.applyBlock({number: 100, hash: '0xAbCd', timestamp: 1_700_000_000}, []);

		expect(await store.resolveBlockNumber({hash: '0xabcd'})).toBe(100);
		expect(await store.resolveBlockNumber({hash: '0xABCD'})).toBe(100);
		expect(await rows(db, `SELECT hash FROM _blocks`)).toEqual([{hash: '0xabcd'}]);
	});
});

describe('addressing by height', () => {
	it('needs no recorded row, because state only changes where our events occur', async () => {
		const db = createTestDB();
		const store = new VersionedStateStore(db, [TOKEN]);
		await store.migrate();
		await store.applyBlock(block(100), [owns('1', '0xAlice', 1)]);
		await store.applyBlock(block(105), [owns('1', '0xBob', 2)]);

		// 103 carried none of our logs, so it has no row. It is still a perfectly
		// good height to read at: the state there is the state left by block 100.
		expect(await store.resolveBlockNumber(103)).toBe(103);
		expect(owner(await store.getAsOf<{owner: string}>('token', {id: '1'}, 103))).toBe('0xAlice');
		expect(await store.getBlock(103)).toBeUndefined();
	});
});

describe('addressing by timestamp', () => {
	it('resolves to the latest recorded block at or before T', async () => {
		const db = createTestDB();
		const store = new VersionedStateStore(db, [TOKEN]);
		await store.migrate();
		await store.applyBlock(block(100, '0x64', 1_000), [owns('1', '0xAlice', 1)]);
		await store.applyBlock(block(105, '0x69', 2_000), [owns('1', '0xBob', 2)]);

		expect(await store.resolveBlockNumber({timestamp: 1_000})).toBe(100); // exactly on
		expect(await store.resolveBlockNumber({timestamp: 1_500})).toBe(100); // between: the EARLIER one
		expect(await store.resolveBlockNumber({timestamp: 1_999})).toBe(100);
		expect(await store.resolveBlockNumber({timestamp: 2_000})).toBe(105);
		expect(await store.resolveBlockNumber({timestamp: 9_999})).toBe(105); // after the last

		expect(owner(await store.getAsOf<{owner: string}>('token', {id: '1'}, {timestamp: 1_500}))).toBe('0xAlice');
		expect(owner(await store.getAsOf<{owner: string}>('token', {id: '1'}, {timestamp: 2_000}))).toBe('0xBob');
	});

	it('resolves to nothing before the first recorded block, not to the first block', async () => {
		const db = createTestDB();
		const store = new VersionedStateStore(db, [TOKEN]);
		await store.migrate();
		await store.applyBlock(block(100, '0x64', 1_000), [owns('1', '0xAlice', 1)]);

		expect(await store.resolveBlockNumber({timestamp: 999})).toBeUndefined();
		const error = await store.getAsOf('token', {id: '1'}, {timestamp: 999}).catch((e) => e);
		expect(error).toBeInstanceOf(NoSuchBlockError);
		expect(error.reason).toBe('no-recorded-block-at-or-before');
	});

	it('picks the highest block when several share a timestamp', async () => {
		const db = createTestDB();
		const store = new VersionedStateStore(db, [TOKEN]);
		await store.migrate();
		await store.applyBlock(block(100, '0x64', 1_000), [owns('1', '0xAlice', 1)]);
		await store.applyBlock(block(101, '0x65', 1_000), [owns('1', '0xBob', 2)]);

		expect(await store.resolveBlockNumber({timestamp: 1_000})).toBe(101);
		expect(owner(await store.getAsOf<{owner: string}>('token', {id: '1'}, {timestamp: 1_000}))).toBe('0xBob');
	});

	it('lets a consumer turn a time into the hash it should pin', async () => {
		const {store} = await threeVersions();
		const recorded = await store.getBlock({timestamp: block(101).timestamp + 5});
		expect(recorded).toEqual(block(101));
		// and that hash is a stable address for the same state
		expect(owner(await store.getAsOf<{owner: string}>('token', {id: '1'}, {hash: recorded!.hash}))).toBe('0xBob');
	});
});

describe('which blocks get a row', () => {
	it('is exactly the blocks handed to the store, gaps included', async () => {
		const db = createTestDB();
		const store = new VersionedStateStore(db, [TOKEN]);
		await store.migrate();
		await store.applyBlock(block(100), [owns('1', '0xAlice', 1)]);
		await store.applyBlock(block(105), [owns('1', '0xBob', 2)]);

		// not one row per chain block: only the blocks that carried our logs
		expect(await rows(db, `SELECT number FROM _blocks ORDER BY number`)).toEqual([{number: 100}, {number: 105}]);
		expect(await store.resolveBlockNumber({hash: block(103).hash})).toBeUndefined();
	});

	it('includes a block that carried our logs but changed nothing, since a consumer can pin it', async () => {
		const db = createTestDB();
		const store = new VersionedStateStore(db, [TOKEN]);
		await store.migrate();
		await store.applyBlock(block(100), [owns('1', '0xAlice', 1)]);
		// block 101 carried a log of ours that produced no state mutation
		await store.applyBlock(block(101), []);

		expect(await store.resolveBlockNumber({hash: block(101).hash})).toBe(101);
		expect(owner(await store.getAsOf<{owner: string}>('token', {id: '1'}, {hash: block(101).hash}))).toBe('0xAlice');
	});
});

describe('a malformed address', () => {
	it('is rejected loudly rather than silently read as some other axis', async () => {
		const {store} = await threeVersions();
		await expect(store.resolveBlockNumber({} as never)).rejects.toThrow(/block address/i);
		await expect(store.resolveBlockNumber({height: 101} as never)).rejects.toThrow(/block address/i);
		await expect(store.resolveBlockNumber(1.5)).rejects.toThrow(/block address/i);
	});
});
