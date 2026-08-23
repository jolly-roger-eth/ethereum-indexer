import type {Abi, LogEvent} from '@etherfold/core';
import {createMutationContext, type Mutation, type StateStore} from '@etherfold/state-store';
import {logs} from 'named-logs';
import {blockPointer, forkPoint, groupByBlock} from './stream.js';
import type {EntityProcessor} from './types.js';

const logger = logs('@etherfold/processor-entities');

/**
 * Run the author's handlers over ONE block's events, collecting the mutations.
 *
 * The staging area is what gives read-your-writes inside the block, and the
 * result is coalesced per business key: see `createMutationContext`.
 */
export async function runBlockHandlers<ABI extends Abi, ProcessorConfig>(
	store: StateStore,
	processor: EntityProcessor<ABI, ProcessorConfig>,
	events: readonly LogEvent<ABI>[],
	config: ProcessorConfig,
): Promise<Mutation[]> {
	const {state, mutations} = createMutationContext(store);

	for (const event of events) {
		if ('decodeError' in event) {
			if (processor.handleUnparsedEvent) {
				await processor.handleUnparsedEvent(state, event);
			}
			continue;
		}
		const handler = (processor as Record<string, unknown>)[`on${event.eventName}`];
		if (typeof handler === 'function') {
			await (handler as (...args: unknown[]) => unknown | Promise<unknown>).call(processor, state, event, config);
		}
	}

	return mutations();
}

/**
 * Apply a whole stream to a store, reverting first if any of it is a retraction.
 *
 * This is the backend-agnostic half of processing, and every backend gets it
 * identically because it is written once, here, against `StateStore`. The stream
 * is a flat list in which reorged-out events carry `removed: true` and are
 * followed by the canonical replacements, if there are any. Three things about
 * how that becomes storage calls are load-bearing:
 *
 * 1. **Revert ONCE, at the fork point**, not per removed event. The fork point
 *    is one below the LOWEST removed block in the stream, and it has to be
 *    computed over the whole stream before anything is applied. Reverting per
 *    event would issue N reverts where the second is a no-op at best and, if the
 *    events were ordered high-to-low, would revert to the wrong height.
 *
 * 2. **A removed event is a removed event, whatever caused it.** The engine
 *    emits retractions both when a height is replaced by a different hash (a
 *    contradiction) and when a block's logs simply vanish with no replacement
 *    (an absence: the transaction went back to the mempool). This reads `removed`
 *    and never looks at what replaced anything, so the second case cannot be
 *    missed. Wiring the revert to "a new hash appeared at this height" would
 *    reproduce `d24872f` one layer down, where the symptom is a row nobody
 *    notices instead of a state object somebody prints.
 *
 * 3. **Revert precedes apply**, which is also what makes replay safe. A store
 *    records a block plainly and a re-applied block raises on purpose.
 *    `revertTo(fork)` drops every block above the fork, and the canonical events
 *    in the same stream are all at or above `fork + 1`, so the replacements
 *    cannot collide with the branch they replace.
 *
 * One block is exactly one `applyBlock`, which is one atomic unit, which is why
 * a handler never has to reason about more than the block it is in.
 */
export async function applyEventStream<ABI extends Abi, ProcessorConfig>(
	store: StateStore,
	processor: EntityProcessor<ABI, ProcessorConfig>,
	eventStream: readonly LogEvent<ABI>[],
	config: ProcessorConfig,
): Promise<void> {
	const fork = forkPoint(eventStream);
	if (fork !== undefined) {
		logger.info(`retraction in stream: reverting state above block ${fork}`);
		await store.revertTo(fork);
	}

	for (const block of groupByBlock(eventStream)) {
		const mutations = await runBlockHandlers(store, processor, block.events, config);
		await store.applyBlock(blockPointer(block), mutations);
	}
}
