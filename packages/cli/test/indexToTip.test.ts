import {describe, expect, it, vi} from 'vitest';
import {indexToTip} from '../src/index.js';

const noWait = async () => {};

// A fake indexer whose indexMore() returns a scripted sequence of {lastToBlock, latestBlock}.
function scriptedIndexer(steps: Array<{lastToBlock: number; latestBlock: number} | Error>) {
	let i = 0;
	const indexMore = vi.fn(async () => {
		const step = steps[Math.min(i, steps.length - 1)];
		i++;
		if (step instanceof Error) throw step;
		return {...step, lastFromBlock: 0, unconfirmedBlocks: [], context: {}};
	});
	return {indexMore};
}

describe('indexToTip — termination', () => {
	it('loops indexMore until lastToBlock reaches latestBlock', async () => {
		const indexer = scriptedIndexer([
			{lastToBlock: 3, latestBlock: 10},
			{lastToBlock: 7, latestBlock: 10},
			{lastToBlock: 10, latestBlock: 10},
		]);
		const result = await indexToTip(indexer, {waitFn: noWait});
		expect(result.lastToBlock).toBe(10);
		expect(result.latestBlock).toBe(10);
		expect(indexer.indexMore).toHaveBeenCalledTimes(3);
	});

	it('returns after a single indexMore when already at tip (no separate eth_blockNumber call)', async () => {
		const indexer = scriptedIndexer([{lastToBlock: 10, latestBlock: 10}]);
		const result = await indexToTip(indexer, {waitFn: noWait});
		// only indexMore is used to discover the tip — exactly one call, no provider.eth_blockNumber
		expect(indexer.indexMore).toHaveBeenCalledTimes(1);
		expect(result.lastToBlock).toBe(10);
	});

	it('follows a moving tip (latestBlock advancing) until it catches up', async () => {
		const indexer = scriptedIndexer([
			{lastToBlock: 5, latestBlock: 10},
			{lastToBlock: 10, latestBlock: 12}, // tip advanced
			{lastToBlock: 12, latestBlock: 12},
		]);
		const result = await indexToTip(indexer, {waitFn: noWait});
		expect(result.latestBlock).toBe(12);
		expect(indexer.indexMore).toHaveBeenCalledTimes(3);
	});
});

describe('indexToTip — bounded retry on transient errors', () => {
	it('retries a transient indexMore error and continues to tip', async () => {
		const indexer = scriptedIndexer([
			{lastToBlock: 3, latestBlock: 10},
			new Error('transient rpc blip'),
			{lastToBlock: 10, latestBlock: 10},
		]);
		const onError = vi.fn();
		const result = await indexToTip(indexer, {waitFn: noWait, onError});
		expect(result.lastToBlock).toBe(10);
		expect(onError).toHaveBeenCalledTimes(1);
	});

	it('gives up (throws) after exceeding maxRetriesPerStep on a persistent error', async () => {
		const indexer = scriptedIndexer([new Error('persistent rpc down')]);
		const onError = vi.fn();
		await expect(indexToTip(indexer, {waitFn: noWait, onError, maxRetriesPerStep: 3})).rejects.toThrow(
			'persistent rpc down',
		);
		// initial attempt + 3 retries = 4 calls
		expect(indexer.indexMore).toHaveBeenCalledTimes(4);
		expect(onError).toHaveBeenCalledTimes(4);
	});
});
