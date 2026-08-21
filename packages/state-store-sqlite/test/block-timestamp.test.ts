import {describe, expect, it} from 'vitest';
import {VersionedStateStore, normalizeBlockTimestamp} from '../src/index.js';
import {createTestDB} from './utils/db.js';
import {TOKEN, owns} from './utils/fixtures.js';

// 2024-01-16T03:32:16Z, as the two encodings a client may hand us.
const HEX = '0x65a5f8c0';
const DECIMAL = '1705375936';
const SECONDS = 1705375936;

describe('normalising blockTimestamp off the log', () => {
	it('reads the two encodings clients actually return as the same instant', async () => {
		// The discrepancy this exists for: the JSON-RPC spec says QUANTITY is
		// 0x-prefixed hex, and at least one client returned it in decimal.
		expect(normalizeBlockTimestamp(HEX)).toBe(SECONDS);
		expect(normalizeBlockTimestamp(DECIMAL)).toBe(SECONDS);
		expect(normalizeBlockTimestamp(HEX)).toBe(normalizeBlockTimestamp(DECIMAL));
	});

	it('does not read a bare decimal string as hex, which would move it by millennia', () => {
		// parseInt(DECIMAL, 16) is ~year 4000. The 0x prefix is the ONLY signal,
		// and guessing from the digits is not possible: '1705366720' is valid hex.
		expect(normalizeBlockTimestamp(DECIMAL)).not.toBe(parseInt(DECIMAL, 16));
		expect(normalizeBlockTimestamp(DECIMAL)).toBeLessThan(2_000_000_000);
	});

	it('accepts what is already a number, and an uppercase prefix', () => {
		expect(normalizeBlockTimestamp(SECONDS)).toBe(SECONDS);
		expect(normalizeBlockTimestamp('0X65A5F8C0')).toBe(SECONDS);
		expect(normalizeBlockTimestamp(BigInt(SECONDS))).toBe(SECONDS);
	});

	it('refuses anything it cannot read, instead of defaulting to zero', () => {
		for (const bad of ['', '0x', 'later', '0xzz', '  ', '12.5', -1, 1.5, NaN, Infinity, null, undefined]) {
			expect(() => normalizeBlockTimestamp(bad as never), JSON.stringify(bad)).toThrow(/timestamp/i);
		}
	});

	it('is what turns a raw log into an addressable block', async () => {
		const db = createTestDB();
		const store = new VersionedStateStore(db, [TOKEN]);
		await store.migrate();

		// two blocks, the same instant expressed differently by two clients
		await store.applyBlock({number: 100, hash: '0x64', parentHash: '0x63', timestamp: normalizeBlockTimestamp(HEX)}, [
			owns('1', '0xAlice', 1),
		]);
		await store.applyBlock(
			{number: 101, hash: '0x65', parentHash: '0x64', timestamp: normalizeBlockTimestamp(String(SECONDS + 12))},
			[owns('1', '0xBob', 2)],
		);

		expect(await store.resolveBlockNumber({timestamp: SECONDS})).toBe(100);
		expect(await store.resolveBlockNumber({timestamp: SECONDS + 11})).toBe(100);
		expect(await store.resolveBlockNumber({timestamp: SECONDS + 12})).toBe(101);
	});
});
