/**
 * Drive the ported processor over a captured stream, one block at a time, and
 * record what it wrote.
 *
 * The recorded `BlockUpdate[]` is the trace every storage candidate replays. It
 * is produced HERE, once, from the real processor over the real stream, so that
 * what the backends are compared on is a property of the processor rather than
 * of whichever backend happened to generate it.
 */
import type {MemoryBlockStore} from '../store/memory.js';
import {createBlockMutations} from '../store/mutation-context.js';
import type {BlockUpdate, Mutation} from '../store/types.js';
import {stratagemsPortedProcessor} from './processor.js';

export type ReplayableBlock = {
	number: number;
	hash: string;
	timestamp?: number;
	events: any[];
};

export type PortRunResult = {
	trace: BlockUpdate[];
	handlerCalls: Record<string, number>;
	unhandledEvents: Record<string, number>;
	stats: {reads: number; stagedReads: number; writes: number; deletes: number};
};

/**
 * One block is one batch: every handler for the block writes into one staging
 * area, and the whole staging area is applied as a single `applyBlock`. That is
 * how blocks arrive, and a benchmark that instead applied each mutation on its
 * own would be measuring a shape the indexer never produces.
 */
export async function runPortOverBlocks(store: MemoryBlockStore, blocks: ReplayableBlock[]): Promise<PortRunResult> {
	const processor = stratagemsPortedProcessor as unknown as Record<string, any>;
	const trace: BlockUpdate[] = [];
	const handlerCalls: Record<string, number> = {};
	const unhandledEvents: Record<string, number> = {};
	const total = {reads: 0, stagedReads: 0, writes: 0, deletes: 0};

	for (const block of blocks) {
		const staging = createBlockMutations((entity, id) => store.get(entity, id));
		for (const event of block.events) {
			if ('decodeError' in event) {
				if (processor.handleUnparsedEvent) {
					await processor.handleUnparsedEvent(staging.ctx, event);
					handlerCalls.handleUnparsedEvent = (handlerCalls.handleUnparsedEvent ?? 0) + 1;
				} else {
					unhandledEvents['<unparsed>'] = (unhandledEvents['<unparsed>'] ?? 0) + 1;
				}
				continue;
			}
			const handlerName = `on${event.eventName}`;
			const handler = processor[handlerName];
			if (typeof handler !== 'function') {
				unhandledEvents[event.eventName] = (unhandledEvents[event.eventName] ?? 0) + 1;
				continue;
			}
			await handler(staging.ctx, event, undefined);
			handlerCalls[handlerName] = (handlerCalls[handlerName] ?? 0) + 1;
		}

		const mutations: Mutation[] = staging.mutations();
		const update: BlockUpdate = {
			block: {number: block.number, hash: block.hash, timestamp: block.timestamp ?? 0},
			mutations,
		};
		await store.applyBlock(update);
		trace.push(update);

		const stats = staging.stats();
		total.reads += stats.reads;
		total.stagedReads += stats.stagedReads;
		total.writes += stats.writes;
		total.deletes += stats.deletes;
	}

	return {trace, handlerCalls, unhandledEvents, stats: total};
}
