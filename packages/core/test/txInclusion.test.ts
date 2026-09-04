import {describe, expect, it} from 'vitest';
import type {Abi} from 'abitype';
import {checkTxInclusion} from '../src/utils/txInclusion.js';
import type {EventBlock, LastSync, LogEvent} from '../src/types.js';

type TestABI = Abi;

const CONTEXT = {source: [{startBlock: 0, hash: 'h'}], config: 'cfg', processor: 'proc'};
const FINALITY = 12;

function txHash(n: number): `0x${string}` {
	return `0x${n.toString(16).padStart(64, '0')}` as `0x${string}`;
}

function event(blockNumber: number, tx: `0x${string}`, over: Partial<LogEvent<TestABI>> = {}): LogEvent<TestABI> {
	return {
		blockNumber,
		blockHash: `0xb${blockNumber.toString(16)}`,
		transactionIndex: 0,
		removed: false,
		address: '0x0000000000000000000000000000000000000000',
		data: '0x',
		topics: [],
		transactionHash: tx,
		logIndex: 0,
		extra: undefined,
		...(over as any),
	} as unknown as LogEvent<TestABI>;
}

function block(number: number, events: LogEvent<TestABI>[]): EventBlock<TestABI> {
	return {number, hash: `0xb${number.toString(16)}`, events};
}

function lastSync(over: Partial<LastSync<TestABI>> = {}): LastSync<TestABI> {
	return {
		context: CONTEXT,
		latestBlock: 100,
		lastFromBlock: 88,
		lastToBlock: 100,
		unconfirmedBlocks: [],
		...over,
	};
}

function check(sync: LastSync<TestABI> | undefined, query: {txHash: string; minedAtBlock?: number}) {
	return checkTxInclusion(sync, [query], FINALITY)[query.txHash];
}

describe('checkTxInclusion', () => {
	it('reports a transaction whose events are in the window as included', () => {
		const sync = lastSync({unconfirmedBlocks: [block(95, [event(95, txHash(1))])]});
		expect(check(sync, {txHash: txHash(1)})).toEqual({
			status: 'included',
			basis: 'window-hit',
			blockNumber: 95,
			blockHash: '0xb5f',
		});
	});

	it('matches the hash case-insensitively', () => {
		const sync = lastSync({unconfirmedBlocks: [block(95, [event(95, txHash(0xabc))])]});
		expect(check(sync, {txHash: txHash(0xabc).toUpperCase().replace('0X', '0x')}).status).toBe('included');
	});

	// The whole point: the app's node and the indexer's node can disagree about
	// WHICH block a transaction is in, so nothing the app holds is compared.
	it('is independent of where the caller thinks the transaction was mined', () => {
		const sync = lastSync({unconfirmedBlocks: [block(95, [event(95, txHash(1))])]});
		// the caller's node saw it in a block the indexer never adopted, one height off
		const verdict = check(sync, {txHash: txHash(1), minedAtBlock: 94});
		expect(verdict.status).toBe('included');
		expect(verdict.blockNumber).toBe(95);
	});

	it('reports a transaction the window does not hold as absent', () => {
		const sync = lastSync({unconfirmedBlocks: [block(95, [event(95, txHash(1))])]});
		expect(check(sync, {txHash: txHash(2)})).toStrictEqual({status: 'absent', basis: 'window-miss'});
	});

	it('reports an unmined transaction as absent, without any receipt', () => {
		expect(check(lastSync(), {txHash: txHash(7)})).toStrictEqual({status: 'absent', basis: 'window-miss'});
	});

	// `feed` publishes the whole new window and only then walks the cursor through
	// it, so presence in the window does not mean the processor has seen it.
	it('reports a window hit above the cursor as not yet processed', () => {
		const sync = lastSync({
			lastToBlock: 94,
			unconfirmedBlocks: [block(95, [event(95, txHash(1))])],
		});
		expect(check(sync, {txHash: txHash(1)})).toStrictEqual({status: 'absent', basis: 'ahead-of-cursor'});
	});

	it('reports a retraction marker in the window as not included', () => {
		const sync = lastSync({unconfirmedBlocks: [block(95, [event(95, txHash(1), {removed: true})])]});
		expect(check(sync, {txHash: txHash(1)}).status).toBe('absent');
	});

	it('reports a receipt ahead of the cursor as absent', () => {
		const sync = lastSync({lastToBlock: 90});
		expect(check(sync, {txHash: txHash(1), minedAtBlock: 96})).toStrictEqual({
			status: 'absent',
			basis: 'ahead-of-cursor',
		});
	});

	// Past finality the two nodes are assumed to agree, which is the same
	// assumption the indexer makes when it drops the block out of its window.
	it('reports a processed transaction below the window as included, on the receipt height', () => {
		const sync = lastSync({latestBlock: 100, lastToBlock: 100});
		expect(check(sync, {txHash: txHash(1), minedAtBlock: 50})).toStrictEqual({
			status: 'included',
			basis: 'below-window',
		});
	});

	it('does not conclude below-window without a receipt height', () => {
		const sync = lastSync({latestBlock: 100, lastToBlock: 100});
		expect(check(sync, {txHash: txHash(1)}).basis).toBe('window-miss');
	});

	describe('when the indexer is behind the chain tip', () => {
		const behind = lastSync({latestBlock: 1000, lastToBlock: 100, unconfirmedBlocks: []});

		it('refuses to answer about a transaction it knows no height for', () => {
			expect(check(behind, {txHash: txHash(1)})).toStrictEqual({status: 'unknown', basis: 'window-not-covering'});
		});

		it('still answers when the receipt puts it beyond the cursor', () => {
			expect(check(behind, {txHash: txHash(1), minedAtBlock: 900}).status).toBe('absent');
		});

		it('still answers when the receipt puts it deep below the cursor', () => {
			expect(check(behind, {txHash: txHash(1), minedAtBlock: 50}).status).toBe('included');
		});
	});

	it('answers nothing before the first sync', () => {
		expect(check(undefined, {txHash: txHash(1), minedAtBlock: 50})).toStrictEqual({
			status: 'unknown',
			basis: 'not-synced',
		});
	});

	it('answers a whole pending set in one pass', () => {
		const sync = lastSync({
			lastToBlock: 96,
			unconfirmedBlocks: [block(95, [event(95, txHash(1)), event(95, txHash(2))]), block(97, [event(97, txHash(3))])],
		});
		const verdicts = checkTxInclusion(sync, [{txHash: txHash(1)}, {txHash: txHash(3)}, {txHash: txHash(4)}], FINALITY);
		expect(verdicts[txHash(1)].status).toBe('included');
		// in the window, but the cursor has not reached block 97
		expect(verdicts[txHash(3)].status).toBe('absent');
		expect(verdicts[txHash(4)].basis).toBe('window-miss');
	});
});
