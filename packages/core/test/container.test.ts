import {describe, expect, it} from 'vitest';
import type {Abi} from 'abitype';
import type {EventProcessor, IndexingSource} from '../src/types.js';
import {EthereumIndexer, IndexerGeneration} from '../src/indexer.js';
import {Indexer, openIndexer, UnheldGenerationError, type GenerationSpec} from '../src/container.js';
import {openMemoryGenerationRegistry} from '../src/generation/memory.js';
import type {GenerationRegistry} from '../src/generation/registry.js';

// ---------------------------------------------------------------------------
// THE GENERATION CONTAINER, beside the shape it lands next to.
// ---------------------------------------------------------------------------
// An indexer HOLDS generations and points at the one that answers reads; what
// used to be called `EthereumIndexer` is ONE of them. Nothing here indexes a
// chain: what is asserted is the container's own three claims -- generations are
// BUILT from factories, reads resolve through the canonical pointer INDIRECTLY,
// and a pointer move is applied AT A NOTIFICATION -- plus the two the expand
// batch exists for: the old name still names the generation, and the old
// construction shape still works.

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
		stateOf: () => fold.handle,
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

describe('the old name and the old shape', () => {
	it('keeps `EthereumIndexer` pointing at the GENERATION, never at the container', () => {
		// The whole correction of the expand batch. `new EthereumIndexer(provider,
		// processor, source, config)` is handed ONE already-constructed processor
		// over ONE already-constructed state, which is a generation; aliasing that
		// identifier to the container would silently re-mean every existing site.
		expect(EthereumIndexer).toBe(IndexerGeneration);
		expect(EthereumIndexer as unknown).not.toBe(Indexer);
	});

	it('still constructs and still drives one processor', async () => {
		const fold = makeFold('old-shape');
		const generation = new EthereumIndexer<Abi, Handle>(makeProvider(), fold.processor, SOURCE);
		expect(generation).toBeInstanceOf(IndexerGeneration);
		await generation.load();
		expect(fold.calls.load).toBe(1);
	});
});

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
					stateOf: () => fold.handle,
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

	it('holds several generations, and only the canonical one answers or indexes', async () => {
		const a = makeFold('A');
		const b = makeFold('B');
		const {indexer} = await openContainer([a, b]);

		expect(indexer.generations.map((held) => held.record.processor)).toEqual(['version-of-A', 'version-of-B']);
		// the FIRST registered is canonical, which is the registry's rule
		expect(indexer.canonical.record.processor).toBe('version-of-A');
		expect(indexer.state.read()).toBe('A');

		await indexer.load();
		// the non-canonical generation does not advance: nothing here follows a
		// shared stream yet, and pretending otherwise is the next landable's job
		expect(a.calls.load).toBe(1);
		expect(b.calls.load).toBe(0);
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
