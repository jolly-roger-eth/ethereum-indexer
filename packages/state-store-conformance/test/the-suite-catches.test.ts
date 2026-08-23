import {
	MemoryStateStore,
	type BlockPointer,
	type EntityId,
	type EntityIdPrefix,
	type Listing,
	type Mutation,
	type NormalizedEntity,
	type StateStore,
	type StateStoreCapabilities,
} from '@etherfold/state-store';
import {describe, expect, it} from 'vitest';
import {runStateStoreConformance, type StateStoreFactory} from '../src/index.js';

/**
 * The test that makes the suite worth running: backends that LIE go red.
 *
 * A conformance suite nobody has ever seen fail is decoration. Each backend
 * below is a working store with exactly one lie in it, and each lie is a real
 * failure mode rather than an invented one:
 *
 * - `LyingWindowStore` claims a retention window and answers outside it anyway.
 *   That is the capability report becoming fiction, which is the failure the
 *   report exists to prevent.
 * - `AmnesiacStore` claims full history and serves every historical read from
 *   the TIP. It is the worst shape a store can fail in, because every answer is
 *   a plausible number nothing downstream can tell apart from a true one.
 * - `StickyCounterStore` does not undo the state a reverted block wrote, so an
 *   accumulated counter does not come back DOWN. That is the canonical reorg bug
 *   this design exists to make impossible
 *   (`work/notes/findings/sqlite-in-the-browser.md` records the real instance: a
 *   `computedPoints` of 12 going back to 6 on revert), and it is why the reorg
 *   case runs on every backend rather than once.
 *
 * Each lie is written as a DECORATOR over the honest store rather than as a
 * subclass overriding one method, because the honest store's refusal is not a
 * method a subclass can forget: it guards `getAsOf` against `this.capabilities`.
 * Wrapping is the only way to build a store whose report and whose behaviour
 * genuinely disagree, which is exactly the backend this suite has to catch.
 *
 * The suite runs through `runStateStoreConformance`, a plain function over the
 * case list rather than a test runner, so a failure here is a value to assert on
 * instead of a red run to interpret.
 */

const honest: StateStoreFactory = (declarations) => new MemoryStateStore(declarations);

/** Names of the cases that failed, as `group > name`, for readable assertions. */
async function failedCases(factory: StateStoreFactory): Promise<string[]> {
	const result = await runStateStoreConformance(factory);
	return result.failures.map((failure) => `${failure.group} > ${failure.name}`);
}

/** An honest store with one lie bolted on; every verb but the lie is delegated. */
class Decorated implements StateStore {
	constructor(protected readonly inner: MemoryStateStore) {}

	get capabilities(): StateStoreCapabilities {
		return this.inner.capabilities;
	}

	get declarations(): ReadonlyMap<string, NormalizedEntity> {
		return this.inner.declarations;
	}

	migrate(): Promise<void> {
		return this.inner.migrate();
	}

	applyBlock(block: BlockPointer, mutations?: readonly Mutation[]): Promise<void> {
		return this.inner.applyBlock(block, mutations);
	}

	getCurrent<T = Record<string, unknown>>(entity: string, id: EntityId): Promise<T | undefined> {
		return this.inner.getCurrent<T>(entity, id);
	}

	getAsOf<T = Record<string, unknown>>(entity: string, id: EntityId, at: number): Promise<T | undefined> {
		return this.inner.getAsOf<T>(entity, id, at);
	}

	listCurrent<T = Record<string, unknown>>(entity: string, prefix: EntityIdPrefix, limit: number): Promise<Listing<T>> {
		return this.inner.listCurrent<T>(entity, prefix, limit);
	}

	listAsOf<T = Record<string, unknown>>(
		entity: string,
		prefix: EntityIdPrefix,
		at: number,
		limit: number,
	): Promise<Listing<T>> {
		return this.inner.listAsOf<T>(entity, prefix, at, limit);
	}

	revertTo(keepUpTo: number): Promise<void> {
		return this.inner.revertTo(keepUpTo);
	}
}

/** Claims a 60-block window, and cheerfully answers a read from long before it. */
class LyingWindowStore extends Decorated {
	override get capabilities(): StateStoreCapabilities {
		return {retention: {kind: 'window', blocks: 60}, asOf: true};
	}
}

/** Claims full history, and answers every as-of read with the tip value. */
class AmnesiacStore extends Decorated {
	override getAsOf<T = Record<string, unknown>>(entity: string, id: EntityId): Promise<T | undefined> {
		return this.inner.getCurrent<T>(entity, id);
	}

	// including the SET read: a collection derived from the tip and presented as
	// a historical one is the same lie, one row at a time.
	override listAsOf<T = Record<string, unknown>>(
		entity: string,
		prefix: EntityIdPrefix,
		_at: number,
		limit: number,
	): Promise<Listing<T>> {
		return this.inner.listCurrent<T>(entity, prefix, limit);
	}
}

/** Accepts the revert and keeps the state: a counter that will not go back down. */
class StickyCounterStore extends Decorated {
	override async revertTo(): Promise<void> {}
}

describe('the conformance suite', () => {
	it('passes an honest backend, so a failure below means something', async () => {
		expect(await failedCases(honest)).toEqual([]);
	});

	it('fails a backend that claims a window it does not honour', async () => {
		const failures = await failedCases((declarations) => new LyingWindowStore(new MemoryStateStore(declarations)));

		expect(failures.length).toBeGreaterThan(0);
		expect(failures.join('\n')).toMatch(/refuses/i);
	});

	it('fails a backend that answers a historical read from the tip', async () => {
		const failures = await failedCases((declarations) => new AmnesiacStore(new MemoryStateStore(declarations)));

		expect(failures.length).toBeGreaterThan(0);
		expect(failures.join('\n')).toMatch(/as of/i);
	});

	it('fails a backend whose revert leaves an accumulated counter where it was', async () => {
		const failures = await failedCases((declarations) => new StickyCounterStore(new MemoryStateStore(declarations)));

		expect(failures.join('\n')).toMatch(/DOWN/);
	});

	it('reports WHY a case failed, and not merely that it did', async () => {
		const result = await runStateStoreConformance(
			(declarations) => new AmnesiacStore(new MemoryStateStore(declarations)),
		);

		expect(result.passed).toBeGreaterThan(0);
		expect(String(result.failures[0]?.error)).toMatch(/expected/i);
	});
});
