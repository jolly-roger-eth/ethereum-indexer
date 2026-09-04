import 'fake-indexeddb/auto';
import {describe, expect, it} from 'vitest';
import {MemoryStateStore} from '@etherfold/state-store';
import {IndexedDBStateStore} from '../src/index.js';
import {processor, runWorkload} from '../browser/workload.js';
import {freshDatabaseName} from './utils/database.js';

/**
 * One processor, on this backend and on the seam's reference store.
 *
 * The workload is the one the browser specs run
 * (`browser/workload.ts`): the same `EntityProcessor` object, the same
 * `applyEventStream` a server-side processor uses, indexing then a retraction
 * then the canonical replacement. In the browser it is compared across
 * RUNTIMES (a tab against node); here it is compared across BACKENDS, in the
 * acceptance gate, where the browser run cannot go.
 *
 * That closes the chain the seam claims: this store agrees with
 * `MemoryStateStore`, and `packages/processor-entities/test/two-backends.test.ts`
 * has `MemoryStateStore` agreeing with `@etherfold/state-store-sqlite`. So the
 * processor a server runs and the processor a tab runs are the same processor,
 * asserted rather than asserted-to.
 *
 * It lives in THIS package because it is the NODE-SIDE HALF of the browser
 * evidence: it runs `browser/workload.ts`, the same module the Playwright specs
 * bundle into a tab, so the two comparisons quote one workload rather than two
 * that resemble each other.
 *
 * It used to say it lived here "to keep the dependency direction one-way ...
 * adding this store to that package's test graph would make the two packages
 * cyclic". That reason was wrong twice over and is corrected rather than
 * deleted, because it is the kind of thing that gets re-derived. ADR-0016's
 * direction rule is about RUNTIME dependencies -- what a published store pulls
 * in, which is what keeps it a primitive -- and `stays-a-primitive.test.ts`
 * asserts exactly that, over `src/` and `dependencies`, saying in as many words
 * that the test graph is out of its scope and that a devDependency is not a
 * dependency. And the test graph IS cyclic today regardless:
 * `@etherfold/processor-entities` devDepends on this store for its four-backend
 * matrix, while this package devDepends on it for the workload above. That is
 * sanctioned, not a violation.
 */

describe('the same processor, on IndexedDB and on the reference store', () => {
	it('lands on the same rows, through indexing, a retraction and its replacement', async () => {
		const memory = new MemoryStateStore(processor.entities);
		await memory.migrate();
		const expected = await runWorkload(memory);

		const indexeddb = new IndexedDBStateStore(processor.entities, {databaseName: freshDatabaseName()});
		await indexeddb.migrate();
		const actual = await runWorkload(indexeddb);

		// the version bounds are compared alongside the values: the two stores agree
		// about WHEN each row was written, not merely about what it says now.
		expect(actual.afterIndexing).toEqual(expected.afterIndexing);
		expect(actual.afterRetraction).toEqual(expected.afterRetraction);
		expect(actual.afterReplacement).toEqual(expected.afterReplacement);
		expect(actual.listing).toEqual(expected.listing);
		await indexeddb.close();
	});

	it('makes the accumulated counter go back DOWN when the block that raised it is retracted', async () => {
		const store = new IndexedDBStateStore(processor.entities, {databaseName: freshDatabaseName()});
		await store.migrate();

		const run = await runWorkload(store);

		// the canonical reorg bug this whole design exists to make impossible, and
		// "the same wrong answer on both backends" is what the literal numbers here
		// rule out.
		expect(run.counterBefore).toBe(5);
		expect(run.counterAfterRetraction).toBe(4);
		expect(run.counterAfterReplacement).toBe(5);
		expect(run.afterReplacement).toEqual([
			{
				entity: 'token',
				id: '1',
				owner: '0x2222222222222222222222222222222222222222',
				transferCount: 2,
				_lower: 101,
				_upper: null,
			},
			{
				entity: 'token',
				id: '2',
				owner: '0x2222222222222222222222222222222222222222',
				transferCount: 3,
				_lower: 103,
				_upper: null,
			},
			{entity: 'counter', name: 'transfers', value: 5, _lower: 103, _upper: null},
		]);
		await store.close();
	});
});
