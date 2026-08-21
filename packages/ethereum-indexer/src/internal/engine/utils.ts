import type {Abi} from 'abitype';
import {logs} from 'named-logs';
import type {EventBlock, LastSync, LogEvent} from '../../types.js';

const namedLogger = logs('ethereum-indexer');

/**
 * How a reorg was concluded.
 *
 * - `contradiction`: the same block height now carries a DIFFERENT hash. This is proof.
 * - `absence`: a block we held is simply not present in the re-fetched range. This is an
 *   INFERENCE, and it is indistinguishable from a sender that under-delivered the range
 *   (a truncated `eth_getLogs`, a wrong address/topic filter). It still reverts state, so
 *   it is reported separately and loudly. See `docs/adr/0004`.
 */
export type ReorgCause = 'contradiction' | 'absence';

export type ReorgDetection = {cause: ReorgCause; blockNumber: number; blockHash: string};

export function wait(seconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

export type BlockOfEvents<ABI extends Abi> = {hash: string; number: number; events: LogEvent<ABI>[]};

export function groupLogsPerBlock<ABI extends Abi>(logEvents: LogEvent<ABI>[]): BlockOfEvents<ABI>[] {
	const groups: {[hash: string]: BlockOfEvents<ABI>} = {};
	const logEventsGroupedPerBlock: BlockOfEvents<ABI>[] = [];
	for (const event of logEvents) {
		if (event.removed) {
			// we skip event removed as we deal with them manually
			// we do not even expect them to be possible here
			// the system is designed to be operating with stateless eth_getLogs rather than stateful filter
			continue;
		}
		let group = groups[event.blockHash];
		if (!group) {
			group = groups[event.blockHash] = {
				hash: event.blockHash,
				number: event.blockNumber,
				events: [],
			};
			logEventsGroupedPerBlock.push(group);
		}
		group.events.push(event);
	}
	return logEventsGroupedPerBlock;
}

export function generateStreamToAppend<ABI extends Abi>(
	lastSync: LastSync<ABI>,
	defaultFromBlock: number,
	newEvents: LogEvent<ABI>[],
	{
		newLatestBlock,
		newLastFromBlock,
		newLastToBlock,
		finality,
	}: {newLatestBlock: number; newLastFromBlock: number; newLastToBlock: number; finality: number},
): {eventStream: LogEvent<ABI>[]; newLastSync: LastSync<ABI>; reorg?: ReorgDetection} {
	const expectedFromBlock = getFromBlock(lastSync, defaultFromBlock, finality);

	if (newLastFromBlock !== expectedFromBlock) {
		let message = `fromBlock (${newLastFromBlock}) not as expected (${expectedFromBlock}).`;
		if (newLastFromBlock > expectedFromBlock) {
			message += `\nThis is too far back, we could trim it automatically, but this is probably an error to send that, so we throw here`;
		} else {
			message += `\nThe fromBlock do not consider the potential of reorg, the only safe fromBlock is ${expectedFromBlock}`;
		}
		throw new Error(message);
	}

	const logEventsGroupedPerBlock = groupLogsPerBlock(newEvents);
	const eventStream: LogEvent<ABI>[] = [];

	const lastUnconfirmedBlocks = lastSync.unconfirmedBlocks;

	// find reorgs
	//
	// This is driven by the blocks we previously held as unconfirmed, NOT by the incoming list.
	// A reorg can REMOVE a block's logs without replacing them at another block-with-logs (the
	// transaction went back to the mempool and is not re-mined yet), in which case the re-fetch
	// legitimately returns FEWER blocks than we hold. Iterating the incoming list would then
	// never look at the vanished block, so its events would never be retracted and it would
	// later be pruned from unconfirmedBlocks silently, baking the dead branch into the state.
	//
	// Incoming blocks are therefore matched by block NUMBER: a missing entry (block no longer
	// has any of our logs) and a differing hash (block replaced) are both a reorg at that block.
	const newBlockHashPerNumber = new Map<number, string>();
	for (const block of logEventsGroupedPerBlock) {
		newBlockHashPerNumber.set(block.number, block.hash);
	}

	let reorgBlock: EventBlock<ABI> | undefined;
	let reorgCause: ReorgCause | undefined;
	let reorgedBlockIndex = 0;
	for (let i = 0; i < lastUnconfirmedBlocks.length; i++) {
		const unconfirmedBlock = lastUnconfirmedBlocks[i];
		if (unconfirmedBlock.number < newLastFromBlock || unconfirmedBlock.number > newLastToBlock) {
			// the re-fetch did not cover this block, so its absence proves nothing
			reorgedBlockIndex = i + 1;
			continue;
		}
		const newHashAtSameHeight = newBlockHashPerNumber.get(unconfirmedBlock.number);
		if (newHashAtSameHeight !== unconfirmedBlock.hash) {
			reorgBlock = unconfirmedBlock;
			// A CONTRADICTION is proof: the same height now carries a different block.
			// An ABSENCE is an inference: the block simply is not in the payload, which is
			// indistinguishable from a sender that under-delivered the range (a truncated
			// eth_getLogs, a wrong filter). Both revert state, so the two are reported
			// separately: a rising rate of absence-driven reverts means truncation or
			// misconfiguration, not chain activity. See docs/adr/0004.
			reorgCause = newHashAtSameHeight === undefined ? 'absence' : 'contradiction';
			reorgedBlockIndex = i;
			break;
		}
		reorgedBlockIndex = i + 1;
	}

	if (reorgBlock && reorgCause) {
		const detail = {
			cause: reorgCause,
			blockNumber: reorgBlock.number,
			blockHash: reorgBlock.hash,
			fromBlock: newLastFromBlock,
			toBlock: newLastToBlock,
		};
		if (reorgCause === 'absence') {
			namedLogger.error(
				`reorg concluded from ABSENCE: block ${reorgBlock.number} (${reorgBlock.hash}) carries no logs in the re-fetched range [${newLastFromBlock}, ${newLastToBlock}]. State will be reverted. If this is frequent, suspect a truncated log fetch or a wrong filter rather than chain reorgs.`,
				detail,
			);
		} else {
			namedLogger.info(`reorg detected at block ${reorgBlock.number} (${reorgBlock.hash} replaced)`, detail);
		}
	}

	if (reorgBlock) {
		// re-add event to the stream but flag them as removed
		for (let i = reorgedBlockIndex; i < lastUnconfirmedBlocks.length; i++) {
			for (const event of lastUnconfirmedBlocks[i].events) {
				eventStream.push({
					...event,
					removed: true,
				});
			}
		}
	}

	const startingBlockForNewEvent = reorgBlock
		? reorgBlock.number
		: lastUnconfirmedBlocks.length > 0
			? lastUnconfirmedBlocks[lastUnconfirmedBlocks.length - 1].number + 1
			: logEventsGroupedPerBlock.length > 0
				? logEventsGroupedPerBlock[0].number
				: 0;
	// the case for 0 is a void case as none of the loop below will be triggered

	// new events and new unconfirmed blocks
	const newUnconfirmedBlocks: EventBlock<ABI>[] = [];

	// re-add older unconfirmed blocks that might get reorg later still
	// only if they are new enough (finality check)
	for (const unconfirmedBlock of lastUnconfirmedBlocks) {
		if (unconfirmedBlock.number < startingBlockForNewEvent) {
			if (newLastToBlock - unconfirmedBlock.number <= finality) {
				newUnconfirmedBlocks.push(unconfirmedBlock);
			}
		}
	}

	for (const block of logEventsGroupedPerBlock) {
		const isUnconfirmedBlock = newLatestBlock - block.number <= finality;
		if (block.events.length > 0 && block.number >= startingBlockForNewEvent) {
			const newEventsPerBlock: LogEvent<ABI>[] = [];
			for (const event of block.events) {
				eventStream.push(event);
				if (isUnconfirmedBlock) {
					newEventsPerBlock.push({...event});
				}
			}
			if (isUnconfirmedBlock) {
				newUnconfirmedBlocks.push({
					hash: block.hash,
					number: block.number,
					events: newEventsPerBlock,
				});
			}
		}
	}

	return {
		eventStream,
		newLastSync: {
			context: lastSync.context,
			lastFromBlock: newLastFromBlock,
			latestBlock: newLatestBlock,
			lastToBlock: newLastToBlock,
			unconfirmedBlocks: newUnconfirmedBlocks,
		},
		reorg:
			reorgBlock && reorgCause
				? {cause: reorgCause, blockNumber: reorgBlock.number, blockHash: reorgBlock.hash}
				: undefined,
	};
}

export function getFromBlock<ABI extends Abi>(
	lastSync: LastSync<ABI>,
	defaultFromBlock: number,
	finality: number,
): number {
	return lastSync.latestBlock === 0
		? defaultFromBlock
		: Math.max(Math.min(lastSync.lastToBlock + 1, lastSync.latestBlock - finality), 0);
}
