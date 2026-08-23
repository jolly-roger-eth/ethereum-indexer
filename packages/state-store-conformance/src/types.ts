import type {EntityDeclaration, StateStore} from '@etherfold/state-store';

/**
 * How the suite gets a store to interrogate: hand it declarations, get a store.
 *
 * This is the whole of what adding a backend costs. The factory is called once
 * per case with the suite's own declarations, so every case starts from an empty
 * store and no case can be poisoned by another; `migrate` is the suite's to
 * call, since a caller has to call it too.
 *
 * A factory that closes over a fresh database per call is the intended shape:
 *
 * ```ts
 * const factory: StateStoreFactory = (declarations) =>
 *   new VersionedStateStore(new RemoteLibSQL(createClient({url: ':memory:'})), declarations);
 * ```
 *
 * What a factory must NOT do is vary its capabilities between calls: the suite
 * reads the report once, from a probe store, and selects the cases the backend
 * has CLAIMED it can pass.
 */
export type StateStoreFactory = (declarations: readonly EntityDeclaration[]) => StateStore | Promise<StateStore>;

/**
 * One conformance case: a name, and a function that throws if the backend is wrong.
 *
 * The cases are data rather than registered tests, which is what lets the suite
 * be run in two ways that both matter. A backend's test file turns each case
 * into a vitest `it` (`describeStateStoreConformance`), so a failure is reported
 * as itself. The suite's own tests RUN the cases against deliberately broken
 * backends and assert on which ones failed
 * (`runStateStoreConformance`), which is the only way to
 * prove the capability cases are not decoration.
 */
export type ConformanceCase = {
	/** The chapter this case belongs to, e.g. `reorg revert`. */
	readonly group: string;
	/** What the case asserts, phrased as the behaviour a caller can rely on. */
	readonly name: string;
	/** Runs the case against a fresh store from the factory. Throws on failure. */
	run(): Promise<void>;
};

/** A case that did not hold, with the assertion error that says why. */
export type ConformanceFailure = {
	readonly group: string;
	readonly name: string;
	readonly error: unknown;
};

/** What a whole run came to. `failures` empty is what "conformant" means. */
export type ConformanceResult = {
	readonly passed: number;
	readonly failures: readonly ConformanceFailure[];
};
