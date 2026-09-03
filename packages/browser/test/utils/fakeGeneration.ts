import type {Abi} from '@etherfold/core';
import {MemoryStateStore} from '@etherfold/state-store';
import type {BrowserGenerationSpec, EntityEventProcessorLike} from '../../src/IndexerState.js';

/**
 * A generation SPEC around a processor a test already hand-rolled.
 *
 * The hook takes the two factories a generation is built from -- its state, then
 * the fold over it -- because an indexer holds any number of generations and
 * each folds into its OWN state, so neither can be a value handed over once.
 * These suites are about the hook's own wiring (dispose, error routing,
 * reconfigure serialization, tx reconciliation) and their processors are fakes
 * that persist nothing, so there is nothing for `createState` to open: it hands
 * back an EMPTY memory store, which is a real `StateStore` that the fold never
 * touches.
 *
 * Deliberately not a cast to `StateStore` over `undefined`: a generation HAS a
 * state even when the fold under test ignores it, and a fixture that lied about
 * that would be the one place a real requirement could go unnoticed.
 */
export function generationOf<ABI extends Abi, ProcessResultType>(
	processor: EntityEventProcessorLike<ABI, ProcessResultType, undefined>,
): BrowserGenerationSpec<ABI, ProcessResultType, undefined> {
	return {
		createState: () => new MemoryStateStore([]),
		createProcessor: () => processor,
	};
}
