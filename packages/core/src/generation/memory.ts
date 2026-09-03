import {
	openGenerationRegistry,
	type GenerationCaps,
	type GenerationId,
	type GenerationRecord,
	type GenerationRegistry,
	type GenerationRegistryPort,
	type GenerationRegistryState,
} from './registry.js';

/**
 * THE REFERENCE SUBSTRATE for the generation registry: three collections in
 * memory.
 *
 * It is here for the same reason `MemoryStateStore` is at the storage seam --
 * the rules live over a PORT, and a port with only one real implementation is a
 * claim nobody has checked. It is also what a runtime with no durable place to
 * put the records uses: a container still needs a canonical pointer to resolve
 * reads through, and a tab that holds ONE generation re-registers it on every
 * boot anyway (`create` RESOLVES an already-registered generation), so a
 * forgetful registry costs that runtime nothing.
 *
 * What it does NOT do is survive a reload, so it is the wrong substrate for a
 * deployment that keeps a superseded generation in order to move the pointer
 * BACK to it. That one wants a durable port
 * (`openGenerationRegistryOnIndexedDB` in `@etherfold/browser`).
 *
 * `commit` applies the registry's decision to the state it was just handed, in
 * one synchronous step, which is what an IndexedDB `readwrite` transaction and a
 * SQL transaction give it for real. One JS heap has no second writer to race,
 * so that is not a simplification here, it is the whole of the guarantee.
 *
 * It reports NO stream subtrees, because it stores none: the streams a runtime
 * keeps live in that runtime's keeper, under its own address. So the sweep finds
 * nothing to collect here rather than pretending to have collected something --
 * a runtime that wants its orphan subtrees swept needs a registry port that can
 * SEE them, which is exactly what the IndexedDB one is.
 */
export function createMemoryGenerationRegistryPort(options?: {
	/** Drop the state store a deleted generation folded into. Nothing, by default. */
	dropState?: (id: GenerationId) => Promise<void>;
}): GenerationRegistryPort {
	const generations = new Map<string, GenerationRecord>();
	const streams = new Set<string>();
	let canonical: GenerationId | undefined;
	// NUL is not producible by a digest or a version hash, so it cannot be read
	// as part of either half. The map key is an implementation detail; the
	// IDENTITY stays two fields, per the registry.
	const keyOf = (id: GenerationId) => `${id.stream}\u0000${id.processor}`;
	const snapshot = (): GenerationRegistryState => ({generations: [...generations.values()], canonical});

	return {
		async read() {
			return snapshot();
		},

		async commit(plan) {
			const write = plan(snapshot());
			if (!write) {
				return;
			}
			for (const id of write.remove ?? []) {
				generations.delete(keyOf(id));
			}
			if (write.put) {
				generations.set(keyOf(write.put), write.put);
			}
			if (write.canonical) {
				canonical = {stream: write.canonical.stream, processor: write.canonical.processor};
			}
		},

		async listStreamDigests() {
			return [...streams].sort();
		},

		async dropStreamSubtree(digest) {
			return streams.delete(digest) ? 1 : 0;
		},

		async dropState(id) {
			await options?.dropState?.(id);
		},
	};
}

/** The registry over that substrate. The caps are the caller's: nothing here has a default. */
export function openMemoryGenerationRegistry(
	caps: GenerationCaps,
	options?: {dropState?: (id: GenerationId) => Promise<void>},
): Promise<GenerationRegistry> {
	return openGenerationRegistry(createMemoryGenerationRegistryPort(options), caps);
}
