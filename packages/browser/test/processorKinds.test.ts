import 'fake-indexeddb/auto';
import {describe, expect, it} from 'vitest';
import type {Abi, EventProcessorWithInitialState, IndexingSource} from '@etherfold/core';
import {EntityEventProcessor, type EntityStateView} from '@etherfold/processor-entities';
import {MemoryStateStore, type StateStore} from '@etherfold/state-store';
import {createBrowserStateStore, createIndexerState, keepStateOnIndexedDB} from '../src/index.js';
import {processor as entityProcessor, type TestABI} from '../browser/workload.js';

/**
 * The hook takes EITHER kind of processor, and which one it is is a TAG the
 * caller writes.
 *
 * The two kinds cannot be told apart by their fields without guessing, and
 * guessing is exactly the failure mode to avoid: a free-form processor and an
 * entity processor are both `EventProcessor`s, so a sniff for
 * `createInitialState` would silently take the wrong branch for any wrapper,
 * proxy or decorator that happened to forward it. So the caller SAYS, in a
 * discriminant the compiler checks.
 *
 * **`pnpm typecheck` is what runs half of this file.** Each `@ts-expect-error`
 * FAILS the typecheck if the line it guards starts compiling, which is the only
 * way to assert that something is NOT accepted. Vitest runs the other half: that
 * the paths the tags select really are different at run time.
 */

const SOURCE: IndexingSource<Abi> = {
	chainId: '1',
	contracts: [{abi: [] as unknown as Abi, address: '0x0000000000000000000000000000000000000001', startBlock: 0}],
};

type State = {count: number};

/** The free-form processor `@etherfold/js-processor` produces, as the hook has always taken it. */
function freeFormProcessor(): EventProcessorWithInitialState<Abi, State, undefined> {
	return {
		getVersionHash: () => 'v1',
		getCodeFingerprint: () => undefined,
		createInitialState: () => ({count: 0}),
		configure: () => {},
		load: async () => undefined,
		process: async () => ({count: 0}),
		reset: async () => {},
		clear: async () => {},
	};
}

function makeProvider() {
	return {
		async request(args: {method: string; params?: any}): Promise<any> {
			switch (args.method) {
				case 'eth_chainId':
					return '0x1';
				case 'eth_blockNumber':
					return '0x0';
				case 'eth_getLogs':
					return [];
				default:
					throw new Error(`unexpected method ${args.method}`);
			}
		},
	} as any;
}

describe('telling the two processor kinds apart', () => {
	it('takes the free-form processor bare, exactly as it always did', async () => {
		const indexer = createIndexerState<Abi, State>(freeFormProcessor());
		await indexer.init({provider: makeProvider(), source: SOURCE});

		// the free-form path seeds its store from `createInitialState()`
		expect(indexer.state.$state).toEqual({count: 0});
	});

	it('takes the same processor tagged, which is the same thing said out loud', async () => {
		const indexer = createIndexerState<Abi, State>({kind: 'js-object', processor: freeFormProcessor()});
		await indexer.init({provider: makeProvider(), source: SOURCE});

		expect(indexer.state.$state).toEqual({count: 0});
	});

	it('takes an entity processor when the caller tags it as one', async () => {
		const store = new MemoryStateStore(entityProcessor.entities);
		const indexer = createIndexerState<TestABI, EntityStateView>({
			kind: 'entities',
			processor: new EntityEventProcessor<TestABI>(store, entityProcessor),
		});

		// the entity path seeds its store from the processor's READ HANDLE: there is
		// no initial state to create, because the state lives in the store.
		expect(typeof indexer.state.$state.getCurrent).toBe('function');
	});

	it('does not compile the wrong processor under the wrong tag', () => {
		// Deliberately never CALLED: the assertions here are the `@ts-expect-error`
		// comments, which `pnpm typecheck` evaluates. Vitest strips types, so running
		// the body would only construct indexers nobody drives -- and would throw the
		// very runtime error the tag exists to turn into a compile error.
		function refusals(entity: EntityEventProcessor<TestABI>) {
			// @ts-expect-error an entity processor has no `createInitialState`, so the bare (free-form) form refuses it
			createIndexerState<TestABI, EntityStateView>(entity);
			// @ts-expect-error nor does tagging it as the other kind make it one
			createIndexerState<TestABI, EntityStateView>({kind: 'js-object', processor: entity});
			// @ts-expect-error and an untagged object is not a processor either: the tag is not optional decoration
			createIndexerState<TestABI, EntityStateView>({processor: entity});
			// @ts-expect-error a tag that is not one of the two kinds names no path
			createIndexerState<Abi, State>({kind: 'js-processor', processor: freeFormProcessor()});
		}

		expect(typeof refusals).toBe('function');
	});

	/**
	 * A keeper on the entity path is refused, and the message says where the
	 * state actually goes.
	 *
	 * `keepState` was the only way a free-form processor could persist anything
	 * when it was written. An entity deployment persists through the store it was
	 * handed, cursor included, so a keeper here is not a second opinion about
	 * where the state lives -- it is a deployment that wired two of them.
	 */
	it('refuses a KeepState keeper on the entity path', () => {
		const store = new MemoryStateStore(entityProcessor.entities);

		expect(() =>
			createIndexerState<TestABI, EntityStateView>(
				{kind: 'entities', processor: new EntityEventProcessor<TestABI>(store, entityProcessor)},
				{keepState: keepStateOnIndexedDB('should-not-be-used') as never},
			),
		).toThrow(/StateStore/);
	});

	it('still refuses a keeper on a free-form processor that cannot take one', () => {
		// unchanged in meaning from before this hook took two kinds
		expect(() =>
			createIndexerState<Abi, State>(freeFormProcessor(), {
				keepState: keepStateOnIndexedDB('should-not-be-used') as never,
			}),
		).toThrow(/keepState/);
	});
});

/**
 * `keepStateOnIndexedDB` and `createBrowserStateStore` both write to IndexedDB
 * and are NOT alternatives to one another.
 *
 * One serialises the whole state object of a free-form processor on every save
 * and keeps no history; the other builds versioned rows behind the storage seam.
 * `BrowserStateStore.ts` carries the paragraph; this is the part a compiler can
 * check, so the day someone "simplifies" one into the other it goes red here.
 */
describe('the two IndexedDB seams are not interchangeable', () => {
	it('does not accept a keeper where a store belongs, nor a store where a keeper does', () => {
		// typecheck-only, as above.
		function refusals(store: StateStore) {
			createIndexerState<Abi, State>(freeFormProcessor(), {
				// @ts-expect-error a `StateStore` is not a `KeepState`: it has no `save`, and its `clear` is not that `clear`
				keepState: store,
			});

			createBrowserStateStore(entityProcessor.entities, {
				// @ts-expect-error a `KeepState` keeper is not a `StateStore` factory
				backend: () => keepStateOnIndexedDB('nope'),
			});
		}

		expect(typeof refusals).toBe('function');
	});
});
