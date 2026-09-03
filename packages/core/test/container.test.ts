import {describe, expect, it} from 'vitest';
import type {Abi} from 'abitype';
import type {EventProcessor, IndexingSource} from '../src/types.js';
import {openIndexer, UnheldGenerationError, type GenerationSpec} from '../src/container.js';
import {openMemoryGenerationRegistry} from '../src/generation/memory.js';
import type {GenerationRegistry} from '../src/generation/registry.js';

// ---------------------------------------------------------------------------
// THE GENERATION CONTAINER, which is now the only shape there is.
// ---------------------------------------------------------------------------
// An indexer HOLDS generations and points at the one that answers reads;
// `IndexerGeneration` is ONE of them. Nothing here indexes a chain: what is
// asserted is the container's own claims -- generations are BUILT from
// factories, reads resolve through the canonical pointer INDIRECTLY, a pointer
// move is applied AT A NOTIFICATION, and a DISCARD is published rather than
// merely applied.

const CHAIN_ID_HEX = '0x1';

function makeProvider() {
	return {
		async request(args: {method: string}): Promise<unknown> {
			switch (args.method) {
				case 'eth_chainId':
					return CHAIN_ID_HEX;
				case 'eth_blockNumber':
					return '0x0';
				case 'eth_getLogs':
					return [];
				default:
					throw new Error(`unexpected method ${args.method}`);
			}
		},
	} as never;
}

const SOURCE: IndexingSource<Abi> = {
	chainId: '1',
	contracts: [{abi: [] as unknown as Abi, address: '0x0000000000000000000000000000000000000001', startBlock: 0}],
};

/** A read HANDLE, like the entity path's: the same object every time, bound to one generation's state. */
type Handle = {read(): string};

/**
 * Which handle belongs to which processor.
 *
 * `stateOf` is asked about a PROCESSOR, and the container re-points the held
 * processor when a swap discards -- so a fixture that answered from a captured
 * variable instead would go on naming the fold that was replaced, which is the
 * one thing these assertions are about.
 */
const handles = new WeakMap<EventProcessor<Abi, Handle>, Handle>();

type Fold = {
	processor: EventProcessor<Abi, Handle>;
	/** The state this generation folds into: a name, so a read says which generation answered. */
	store: {name: string; opened: number};
	handle: Handle;
	calls: {load: number; process: number};
};

function makeFold(name: string): Fold {
	const store = {name, opened: 0};
	const handle: Handle = {read: () => store.name};
	const calls = {load: 0, process: 0};
	const processor: EventProcessor<Abi, Handle> = {
		getVersionHash: () => `version-of-${name}`,
		getCodeFingerprint: () => undefined,
		load: async () => {
			calls.load++;
			return undefined;
		},
		process: async () => {
			calls.process++;
			return handle;
		},
		reset: async () => {},
		clear: async () => {},
	};
	handles.set(processor, handle);
	return {processor, store, handle, calls};
}

/** The two factories, in the order a generation's identity forces: state, then the fold over it. */
function specFor(fold: Fold): GenerationSpec<Abi, Handle, {name: string; opened: number}> {
	return {
		createState: () => {
			fold.store.opened++;
			return fold.store;
		},
		createProcessor: () => fold.processor,
		stateOf: (processor) => handles.get(processor) as Handle,
	};
}

async function openContainer(folds: Fold[], registry?: GenerationRegistry) {
	const held = registry ?? (await openMemoryGenerationRegistry({maxGenerations: 4, maxStreams: 2}));
	const indexer = await openIndexer<Abi, Handle>({
		registry: held,
		provider: makeProvider(),
		source: SOURCE,
		generations: folds.map(specFor),
	});
	return {indexer, registry: held};
}

describe('the generation container', () => {
	it('BUILDS each generation from its factories: state first, then the fold over it', async () => {
		const order: string[] = [];
		const fold = makeFold('A');
		const registry = await openMemoryGenerationRegistry({maxGenerations: 2, maxStreams: 1});
		const indexer = await openIndexer<Abi, Handle>({
			registry,
			provider: makeProvider(),
			source: SOURCE,
			generations: [
				{
					createState: (context) => {
						order.push(`state:${context.stream}`);
						return fold.store;
					},
					createProcessor: (state, context) => {
						order.push(`processor:${(state as {name: string}).name}:${context.stream}`);
						return fold.processor;
					},
					stateOf: (processor) => handles.get(processor) as Handle,
				},
			],
		});

		const stream = indexer.canonical.record.stream;
		expect(order).toEqual([`state:${stream}`, `processor:A:${stream}`]);
		// the fold half of the identity is the processor's OWN version hash, taken
		// after it was built rather than declared twice
		expect(indexer.canonical.record.processor).toBe('version-of-A');
		expect(await registry.canonical()).toMatchObject({stream, processor: 'version-of-A'});
	});

	it('holds several generations, and only the canonical one ANSWERS', async () => {
		const a = makeFold('A');
		const b = makeFold('B');
		const {indexer} = await openContainer([a, b]);

		expect(indexer.generations.map((held) => held.record.processor)).toEqual(['version-of-A', 'version-of-B']);
		// the FIRST registered is canonical, which is the registry's rule
		expect(indexer.canonical.record.processor).toBe('version-of-A');
		expect(indexer.state.read()).toBe('A');

		await indexer.load();
		// EVERY generation loads, because every generation advances: a fold that
		// never loaded has no state and no cursor to advance from. Which one ANSWERS
		// is still the canonical pointer's decision and nothing else's.
		expect(a.calls.load).toBe(1);
		expect(b.calls.load).toBe(1);
		expect(indexer.state.read()).toBe('A');
		// ...and the second one is a FOLLOWER, because it shares the first's stream
		expect(indexer.generations.map((held) => held.follows)).toEqual([false, true]);
	});

	it('gives each generation its OWN state, built once', async () => {
		const a = makeFold('A');
		const b = makeFold('B');
		await openContainer([a, b]);
		expect(a.store.opened).toBe(1);
		expect(b.store.opened).toBe(1);
	});

	it('refuses to point reads at a generation it does not hold', async () => {
		const a = makeFold('A');
		const {indexer} = await openContainer([a]);
		await expect(indexer.promote({stream: indexer.canonical.record.stream, processor: 'version-of-B'})).rejects.toThrow(
			UnheldGenerationError,
		);
	});
});

describe('the state handle is INDIRECT', () => {
	it('keeps answering across a pointer move, from the newly canonical generation', async () => {
		const a = makeFold('A');
		const b = makeFold('B');
		const {indexer} = await openContainer([a, b]);

		// story 6: a reader holds the handle ACROSS the move and never re-reads it
		const handle = indexer.state;
		expect(handle.read()).toBe('A');

		await indexer.promote(indexer.generations[1].record);

		expect(handle.read()).toBe('B');
		// ...and it is the same object, because a handle whose identity changed on
		// every publication would defeat exactly the callers who keep one
		expect(indexer.state).toBe(handle);
	});

	it('follows the pointer BACK, which is what makes a promotion revertible', async () => {
		const a = makeFold('A');
		const b = makeFold('B');
		const {indexer} = await openContainer([a, b]);
		const handle = indexer.state;

		await indexer.promote(indexer.generations[1].record);
		expect(handle.read()).toBe('B');
		await indexer.promote(indexer.generations[0].record);
		expect(handle.read()).toBe('A');
	});
});

/**
 * A DISCARD IS PUBLISHED, and the container is what publishes it.
 *
 * `onStateUpdated` fires when a state is ADOPTED or PRODUCED, and a discard is
 * neither (`ReconfigureOutcome`), so a subscriber holding the state the fold
 * just lost is told by nothing -- and on the reconfigure this exists for (a
 * contract redeployed behind its proxy, which has emitted nothing yet) the next
 * publication never comes at all.
 *
 * The browser hook used to fill that silence itself. It is HERE now, because the
 * container is what knows a verb discarded, and because a consumer that drives
 * the container without that hook (a server, a CLI, a test) was never told at
 * all.
 */
describe('a discard is PUBLISHED and not merely applied', () => {
	it('tells subscribers when a processor swap discarded the fold', async () => {
		const a = makeFold('A');
		const b = makeFold('B');
		const {indexer} = await openContainer([a]);

		const published: string[] = [];
		indexer.onStateUpdated = (state) => published.push(state.read());

		expect(await indexer.updateProcessor(b.processor)).toEqual({stateDiscarded: true});

		// the NEW fold's handle, because the old one no longer exists: a subscriber
		// that kept what it was handed is now reading the generation that is folding
		expect(published).toEqual(['B']);
		expect(indexer.state.read()).toBe('B');
	});

	it('tells subscribers when an explicit reset discarded the fold', async () => {
		const a = makeFold('A');
		const {indexer} = await openContainer([a]);

		const published: string[] = [];
		indexer.onStateUpdated = (state) => published.push(state.read());

		expect(await indexer.reset()).toEqual({stateDiscarded: true});
		expect(published).toEqual(['A']);
	});

	it('says nothing when the reconfigure kept the fold', async () => {
		const a = makeFold('A');
		const {indexer} = await openContainer([a]);

		const published: string[] = [];
		indexer.onStateUpdated = (state) => published.push(state.read());

		// the same version hash, unforced: the core skips the swap, so there is
		// nothing to say -- and a store blanked on every save would be its own bug
		expect(await indexer.updateProcessor(a.processor)).toEqual({stateDiscarded: false});
		expect(published).toEqual([]);
	});
});

describe('the read unit of work is the interval between notifications', () => {
	it('applies a pointer move AT a notification, and not when the registry records it', async () => {
		const a = makeFold('A');
		const b = makeFold('B');
		const {indexer, registry} = await openContainer([a, b]);

		const log: string[] = [];
		indexer.onStateUpdated = (state) => log.push(`notify:${state.read()}`);

		log.push(`read:${indexer.state.read()}`);
		// the DECISION is recorded durably here...
		await registry.moveCanonicalTo(indexer.generations[1].record);
		// ...and the READ PATH has not moved with it, because nothing was notified:
		// every read in this interval still answers from ONE generation
		log.push(`read:${indexer.state.read()}`);
		log.push(`read:${indexer.state.read()}`);

		await indexer.promote(indexer.generations[1].record);
		log.push(`read:${indexer.state.read()}`);

		expect(log).toEqual(['read:A', 'read:A', 'read:A', 'notify:B', 'read:B']);
	});

	it('publishes the INDIRECT handle to the notification, not the generation it came from', async () => {
		const a = makeFold('A');
		const b = makeFold('B');
		const {indexer} = await openContainer([a, b]);

		let published: Handle | undefined;
		indexer.onStateUpdated = (state) => {
			published = state;
		};
		await indexer.promote(indexer.generations[1].record);

		// a subscriber that KEEPS what it was handed keeps something that follows
		// the pointer, rather than a reference to the generation that was canonical
		// at the moment it was told
		expect(published).toBe(indexer.state);
		expect(published?.read()).toBe('B');
		await indexer.promote(indexer.generations[0].record);
		expect(published?.read()).toBe('A');
	});
});
