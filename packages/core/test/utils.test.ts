import {describe, expect, it} from 'vitest';
import type {Abi} from 'abitype';
import {
	generateStreamToAppend,
	getFromBlock,
	groupLogsPerBlock,
	resolveStreamConfig,
	streamConfigHashOf,
} from '../src/internal/engine/utils.js';
import type {EventBlock, LastSync, LogEvent} from '../src/types.js';

type TestABI = Abi;

const CONTEXT = {source: [{startBlock: 0, hash: 'h'}], config: 'cfg', processor: 'proc'};

function lastSync(over: Partial<LastSync<TestABI>> = {}): LastSync<TestABI> {
	return {
		context: CONTEXT,
		latestBlock: 0,
		lastFromBlock: 0,
		lastToBlock: 0,
		unconfirmedBlocks: [],
		...over,
	};
}

let logCounter = 0;
// Build a minimal LogEvent. Only the fields used by the stream logic matter
// (blockNumber, blockHash, transactionHash, removed). The rest are filled to
// satisfy the type without affecting behaviour.
function makeEvent(blockNumber: number, blockHash: string, extra: Partial<LogEvent<TestABI>> = {}): LogEvent<TestABI> {
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
		// parsed-event fields are not needed for stream logic; cast keeps types happy
		...(extra as any),
	} as unknown as LogEvent<TestABI>;
}

function block(number: number, hash: string, events: LogEvent<TestABI>[]): EventBlock<TestABI> {
	return {number, hash, events};
}

describe('getFromBlock', () => {
	it('returns defaultFromBlock when never synced (latestBlock === 0)', () => {
		expect(getFromBlock(lastSync({latestBlock: 0, lastToBlock: 0}), 100, 12)).toBe(100);
	});

	it('returns lastToBlock + 1 when well within the finality window', () => {
		const ls = lastSync({latestBlock: 1000, lastToBlock: 500});
		// min(501, 1000-12=988) = 501
		expect(getFromBlock(ls, 0, 12)).toBe(501);
	});

	it('never goes past latestBlock - finality (re-scans the unconfirmed window)', () => {
		const ls = lastSync({latestBlock: 1000, lastToBlock: 999});
		// min(1000, 988) = 988
		expect(getFromBlock(ls, 0, 12)).toBe(988);
	});

	it('never returns a negative block', () => {
		const ls = lastSync({latestBlock: 5, lastToBlock: 4});
		// min(5, 5-12=-7) = -7 -> clamped to 0
		expect(getFromBlock(ls, 0, 12)).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// AN EXPLICIT `undefined` IS AN ABSENT KEY
// ---------------------------------------------------------------------------
// Every field of a `ProvidedStreamConfig` is optional, so `{finality: undefined}`
// type-checks -- and it is what a JSON round-trip or an options object built as
// `{finality: opts.finality}` produces, which makes it ordinary rather than
// exotic. A plain spread let it overwrite the default back to nothing, and the
// damage was silent on three axes at once: the reorg arithmetic went NaN, the
// config hashed as though no default applied, and it therefore read as a
// DIFFERENT config from every other spelling of the same default. The digest
// this feeds already collapses explicit-undefined to absent (`hash.test.ts`), so
// the resolver is simply made to agree with it.
// ---------------------------------------------------------------------------

describe('resolveStreamConfig', () => {
	it('fills the default when the config is absent, empty, or leaves finality unset', () => {
		expect(resolveStreamConfig(undefined)).toEqual({finality: 17});
		expect(resolveStreamConfig({})).toEqual({finality: 17});
		expect(resolveStreamConfig({alwaysFetchTimestamps: true})).toEqual({finality: 17, alwaysFetchTimestamps: true});
	});

	it('treats an explicit `undefined` finality as ABSENT, not as a value', () => {
		expect(resolveStreamConfig({finality: undefined})).toEqual({finality: 17});
		// the shape a JSON round-trip produces, and the shape an options object
		// forwarding an unset flag produces
		expect(resolveStreamConfig(JSON.parse(JSON.stringify({finality: undefined})))).toEqual({finality: 17});
		expect(resolveStreamConfig({finality: undefined, alwaysFetchTimestamps: true})).toEqual({
			finality: 17,
			alwaysFetchTimestamps: true,
		});
	});

	it('drops any other explicitly-undefined key rather than carrying it', () => {
		// asserted on the KEYS, not with `toEqual`: `toEqual` ignores undefined-valued
		// properties, so it would pass just as happily on a config that carried them
		expect(Object.keys(resolveStreamConfig({alwaysFetchTimestamps: undefined}))).toEqual(['finality']);
		expect(Object.keys(resolveStreamConfig({alwaysFetchTransactions: undefined, parse: undefined}))).toEqual([
			'finality',
		]);
		expect(resolveStreamConfig({alwaysFetchTimestamps: undefined})).toStrictEqual({finality: 17});
		// a carried `undefined` is not merely untidy: `canonical_form` drops it, so the
		// object and its digest would disagree about which keys the config has
		expect(Object.keys(resolveStreamConfig({finality: undefined}))).toEqual(['finality']);
	});

	it('still lets a REAL value win, including a falsy one', () => {
		expect(resolveStreamConfig({finality: 5})).toEqual({finality: 5});
		// 0 is a value, not an absence: a chain with no reorgs is a legitimate config
		expect(resolveStreamConfig({finality: 0})).toEqual({finality: 0});
		expect(resolveStreamConfig({alwaysFetchTimestamps: false})).toEqual({finality: 17, alwaysFetchTimestamps: false});
	});

	it('is IDEMPOTENT, so resolving an already-resolved config moves nothing', () => {
		for (const provided of [undefined, {}, {finality: undefined}, {finality: 5}, {alwaysFetchTimestamps: true}]) {
			expect(resolveStreamConfig(resolveStreamConfig(provided))).toEqual(resolveStreamConfig(provided));
		}
	});

	it('keeps the reorg window ARITHMETIC out of NaN', () => {
		// the consequence that made this worth fixing rather than noting: `getFromBlock`
		// subtracts `finality` from the head, so an undefined one poisons the block the
		// next round asks from
		const ls = lastSync({latestBlock: 1000, lastToBlock: 999});
		expect(getFromBlock(ls, 0, resolveStreamConfig({finality: undefined}).finality)).toBe(983);
		expect(getFromBlock(ls, 0, resolveStreamConfig({}).finality)).toBe(983);
	});

	it('makes every spelling of the default ONE config to the digest', () => {
		// the third axis: the hash is what decides a reconfigure is a no-op, so a
		// spelling that hashes differently is a full re-index
		const theDefault = streamConfigHashOf({});
		expect(streamConfigHashOf({finality: undefined})).toBe(theDefault);
		expect(streamConfigHashOf(undefined)).toBe(theDefault);
		expect(streamConfigHashOf({finality: 17})).toBe(theDefault);
		// and a config that genuinely moved is still its own digest
		expect(streamConfigHashOf({finality: 5})).not.toBe(theDefault);
	});
});

describe('groupLogsPerBlock', () => {
	it('groups events by blockHash preserving order', () => {
		const e1 = makeEvent(10, '0xa');
		const e2 = makeEvent(10, '0xa');
		const e3 = makeEvent(11, '0xb');
		const groups = groupLogsPerBlock([e1, e2, e3]);
		expect(groups).toHaveLength(2);
		expect(groups[0].hash).toBe('0xa');
		expect(groups[0].events).toHaveLength(2);
		expect(groups[1].hash).toBe('0xb');
		expect(groups[1].events).toHaveLength(1);
	});

	it('skips removed events', () => {
		const e1 = makeEvent(10, '0xa');
		const e2 = makeEvent(10, '0xa', {removed: true});
		const groups = groupLogsPerBlock([e1, e2]);
		expect(groups).toHaveLength(1);
		expect(groups[0].events).toHaveLength(1);
	});
});

describe('generateStreamToAppend', () => {
	const finality = 12;

	it('throws when newLastFromBlock does not match the expected fromBlock', () => {
		const ls = lastSync({latestBlock: 1000, lastToBlock: 500});
		// expected fromBlock = min(501, 988) = 501
		expect(() =>
			generateStreamToAppend(ls, 0, [], {
				newLatestBlock: 1000,
				newLastToBlock: 600,
				newLastFromBlock: 400, // wrong
				finality,
			}),
		).toThrow();
	});

	it('appends fresh events on a clean first sync and records unconfirmed blocks', () => {
		const ls = lastSync({latestBlock: 0, lastToBlock: 0, lastFromBlock: 0});
		const events = [makeEvent(100, '0x100'), makeEvent(101, '0x101')];
		const {eventStream, newLastSync} = generateStreamToAppend(ls, 0, events, {
			newLatestBlock: 105,
			newLastToBlock: 105,
			newLastFromBlock: 0, // first sync -> getFromBlock returns defaultFromBlock (0)
			finality,
		});
		expect(eventStream).toHaveLength(2);
		expect(eventStream.every((e) => !e.removed)).toBe(true);
		// both blocks are within finality of latest (105 - 100 <= 12 is false for 100? 105-100=5 <=12 true)
		expect(newLastSync.unconfirmedBlocks.map((b) => b.number)).toEqual([100, 101]);
		expect(newLastSync.latestBlock).toBe(105);
		expect(newLastSync.lastToBlock).toBe(105);
	});

	it('does not track blocks as unconfirmed when they are older than the finality window', () => {
		const ls = lastSync({latestBlock: 0});
		const events = [makeEvent(10, '0x10')];
		const {newLastSync} = generateStreamToAppend(ls, 0, events, {
			newLatestBlock: 1000, // 1000 - 10 = 990 > finality => confirmed
			newLastToBlock: 1000,
			newLastFromBlock: 0,
			finality,
		});
		expect(newLastSync.unconfirmedBlocks).toHaveLength(0);
	});

	it('handles a single-block reorg: emits removed events then the new ones', () => {
		// Previous sync had unconfirmed block 100 with hash 0xAAA containing one event.
		const prevEvent = makeEvent(100, '0xAAA');
		const ls = lastSync({
			latestBlock: 100,
			lastToBlock: 100,
			lastFromBlock: 89, // expected fromBlock for next call
			unconfirmedBlocks: [block(100, '0xAAA', [prevEvent])],
		});
		// getFromBlock(ls) = min(101, 100-12=88) ... wait latest=100 -> 88. Use that as newLastFromBlock.
		const expectedFrom = getFromBlock(ls, 0, finality); // 88
		// Reorg: block 100 now has a different hash 0xBBB with a new event.
		const newEvent = makeEvent(100, '0xBBB');
		const {eventStream, newLastSync} = generateStreamToAppend(ls, 0, [newEvent], {
			newLatestBlock: 101,
			newLastToBlock: 101,
			newLastFromBlock: expectedFrom,
			finality,
		});
		// First the reorged-out event flagged removed, then the new event.
		expect(eventStream).toHaveLength(2);
		expect(eventStream[0].removed).toBe(true);
		expect(eventStream[0].blockHash).toBe('0xAAA');
		expect(eventStream[1].removed).toBe(false);
		expect(eventStream[1].blockHash).toBe('0xBBB');
		// The new unconfirmed set reflects the canonical chain.
		expect(newLastSync.unconfirmedBlocks.map((b) => b.hash)).toEqual(['0xBBB']);
	});

	it('keeps appending without removals when unconfirmed blocks still match', () => {
		const prevEvent = makeEvent(100, '0xAAA');
		const ls = lastSync({
			latestBlock: 100,
			lastToBlock: 100,
			unconfirmedBlocks: [block(100, '0xAAA', [prevEvent])],
		});
		const expectedFrom = getFromBlock(ls, 0, finality);
		// Re-fetch includes the same block 100 (0xAAA) plus a new block 101.
		const sameEvent = makeEvent(100, '0xAAA');
		const newEvent = makeEvent(101, '0xBBB');
		const {eventStream} = generateStreamToAppend(ls, 0, [sameEvent, newEvent], {
			newLatestBlock: 101,
			newLastToBlock: 101,
			newLastFromBlock: expectedFrom,
			finality,
		});
		// No removals; only the genuinely-new block 101 event is appended.
		expect(eventStream.some((e) => e.removed)).toBe(false);
		expect(eventStream).toHaveLength(1);
		expect(eventStream[0].blockHash).toBe('0xBBB');
	});

	// Regression: a reorg that REMOVES an unconfirmed block's logs without replacing them at
	// another block-with-logs (e.g. the tx went back to the mempool and is not re-mined yet).
	// The re-fetch legitimately returns a SHORTER list than unconfirmedBlocks, so a comparison
	// driven by the incoming list alone never looks at the vanished block.
	it('detects a reorg when a trailing unconfirmed block vanishes from the re-fetch', () => {
		const event100 = makeEvent(100, '0xAAA');
		const event105 = makeEvent(105, '0xBBB');
		const ls = lastSync({
			latestBlock: 105,
			lastToBlock: 105,
			unconfirmedBlocks: [block(100, '0xAAA', [event100]), block(105, '0xBBB', [event105])],
		});
		const expectedFrom = getFromBlock(ls, 0, finality); // 93, covers both unconfirmed blocks
		// Block 105 was reorged out; its log is gone. Block 100 is untouched and still returned.
		const {eventStream, newLastSync} = generateStreamToAppend(ls, 0, [makeEvent(100, '0xAAA')], {
			newLatestBlock: 106,
			newLastToBlock: 106,
			newLastFromBlock: expectedFrom,
			finality,
		});
		// The vanished block's event must be retracted...
		expect(eventStream).toHaveLength(1);
		expect(eventStream[0].removed).toBe(true);
		expect(eventStream[0].blockHash).toBe('0xBBB');
		// ...and it must not linger in the unconfirmed set (where it would later be pruned silently).
		expect(newLastSync.unconfirmedBlocks.map((b) => b.hash)).toEqual(['0xAAA']);
	});

	// A reorg is concluded in two very different ways, and ADR-0004 requires them to be
	// distinguishable: a CONTRADICTION (the same height now has a different hash) is proof,
	// while an ABSENCE (a block we hold is simply not in the payload) is an inference, and it
	// is the inference that silently deletes state when a sender under-delivers a range.
	it('reports a hash contradiction as the reorg cause', () => {
		const prevEvent = makeEvent(100, '0xAAA');
		const ls = lastSync({
			latestBlock: 100,
			lastToBlock: 100,
			unconfirmedBlocks: [block(100, '0xAAA', [prevEvent])],
		});
		const {reorg} = generateStreamToAppend(ls, 0, [makeEvent(100, '0xBBB')], {
			newLatestBlock: 101,
			newLastToBlock: 101,
			newLastFromBlock: getFromBlock(ls, 0, finality),
			finality,
		});
		expect(reorg).toEqual({cause: 'contradiction', blockNumber: 100, blockHash: '0xAAA'});
	});

	it('reports a vanished block as an absence, not a contradiction', () => {
		const prevEvent = makeEvent(100, '0xAAA');
		const ls = lastSync({
			latestBlock: 100,
			lastToBlock: 100,
			unconfirmedBlocks: [block(100, '0xAAA', [prevEvent])],
		});
		const {reorg} = generateStreamToAppend(ls, 0, [], {
			newLatestBlock: 101,
			newLastToBlock: 101,
			newLastFromBlock: getFromBlock(ls, 0, finality),
			finality,
		});
		expect(reorg).toEqual({cause: 'absence', blockNumber: 100, blockHash: '0xAAA'});
	});

	it('reports no reorg when nothing was reverted', () => {
		const ls = lastSync({latestBlock: 1000, lastToBlock: 1000});
		const {reorg} = generateStreamToAppend(ls, 0, [], {
			newLatestBlock: 1001,
			newLastToBlock: 1001,
			newLastFromBlock: getFromBlock(ls, 0, finality),
			finality,
		});
		expect(reorg).toBeUndefined();
	});

	it('detects a reorg when ALL unconfirmed blocks vanish (empty re-fetch)', () => {
		const prevEvent = makeEvent(100, '0xAAA');
		const ls = lastSync({
			latestBlock: 100,
			lastToBlock: 100,
			unconfirmedBlocks: [block(100, '0xAAA', [prevEvent])],
		});
		const expectedFrom = getFromBlock(ls, 0, finality);
		const {eventStream, newLastSync} = generateStreamToAppend(ls, 0, [], {
			newLatestBlock: 101,
			newLastToBlock: 101,
			newLastFromBlock: expectedFrom,
			finality,
		});
		expect(eventStream).toHaveLength(1);
		expect(eventStream[0].removed).toBe(true);
		expect(eventStream[0].blockHash).toBe('0xAAA');
		expect(newLastSync.unconfirmedBlocks).toHaveLength(0);
	});

	it('does not treat an unconfirmed block as reorged when it is outside the re-fetched range', () => {
		// Defensive: only blocks the re-fetch actually covered can be judged missing.
		const prevEvent = makeEvent(100, '0xAAA');
		const ls = lastSync({
			latestBlock: 100,
			lastToBlock: 100,
			unconfirmedBlocks: [block(100, '0xAAA', [prevEvent])],
		});
		const expectedFrom = getFromBlock(ls, 0, finality);
		// A narrow re-fetch that stops BELOW the unconfirmed block.
		const {eventStream} = generateStreamToAppend(ls, 0, [], {
			newLatestBlock: 100,
			newLastToBlock: 95,
			newLastFromBlock: expectedFrom,
			finality,
		});
		expect(eventStream).toHaveLength(0);
	});

	it('produces an empty stream when there are no new events and nothing to reorg', () => {
		const ls = lastSync({latestBlock: 1000, lastToBlock: 1000});
		const expectedFrom = getFromBlock(ls, 0, finality);
		const {eventStream, newLastSync} = generateStreamToAppend(ls, 0, [], {
			newLatestBlock: 1001,
			newLastToBlock: 1001,
			newLastFromBlock: expectedFrom,
			finality,
		});
		expect(eventStream).toHaveLength(0);
		expect(newLastSync.latestBlock).toBe(1001);
	});
});
