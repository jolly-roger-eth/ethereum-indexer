import {
	openGenerationRegistry,
	type GenerationCaps,
	type GenerationId,
	type GenerationRecord,
	type GenerationRegistry,
	type GenerationRegistryPort,
	type GenerationRegistryState,
} from '@etherfold/core';
import {promisifyRequest, type UseStore} from 'idb-keyval';
import {keyvalStore} from '../keyval.js';
import {streamsUnder, streamSubtree} from '../stream/OnIndexedDB.js';

/** The leading literal, so the registry keyspace cannot be a prefix of another. */
const GENERATION = 'generation';
/** The generation records' own level, beside the pointer. */
const ENTRY = 'entry';
/** The canonical pointer's own key. One per indexer, by construction. */
const CANONICAL = 'canonical';

/**
 * The registry's address under one indexer name: HIERARCHICAL array keys, in the
 * same object store the streams live in.
 *
 * ```
 * ['generation', <indexer-name>, 'canonical']                        the pointer
 * ['generation', <indexer-name>, 'entry', <streamDigest>, <processor>]  a generation
 * ```
 *
 * The two halves of a generation's identity are two KEY ELEMENTS and never one
 * delimited string, for the reason the stream address is hierarchical (ADR-0036):
 * elements compare element by element, so no rendering of one component can be
 * read as another's. It also makes "every generation on this stream" -- what
 * reaping asks -- a scoped range rather than a scan.
 *
 * `'canonical'` sorts BELOW `'entry'`, so the pointer sits outside the entry
 * range and a scoped read of the generations never picks it up. That is the same
 * trap the stream subtree's two ranges carry, and the same fix.
 */
export function generationAddress(name: string) {
	const prefix: IDBValidKey[] = [GENERATION, name];
	return {
		prefix,
		canonical: [...prefix, CANONICAL] as IDBValidKey,
		entry: (id: GenerationId) => [...prefix, ENTRY, id.stream, id.processor] as IDBValidKey,
		/** Every generation record under this name, and nothing else. */
		entries: IDBKeyRange.bound([...prefix, ENTRY], [...prefix, ENTRY, []], true, false),
	};
}

/**
 * The five substrate operations, over one `UseStore` and ONE named indexer.
 *
 * `commit` is a RAW `readwrite` transaction that reads the records, applies the
 * registry's decision and writes, and NOT a read followed by a write: two tabs
 * that both read "one generation, a cap of two" and then both wrote would leave
 * three generations under a cap of two, with nothing afterwards able to detect
 * it. IndexedDB serialises overlapping `readwrite` transactions on one object
 * store, across tabs, so that is all the mutual exclusion this needs. It is the
 * same rule the stream keeper's commit follows, including its one constraint:
 * inside a transaction you may await only IndexedDB's own promises.
 */
export function generationRegistryPortOnIndexedDB(
	name: string,
	options: {store?: UseStore; dropState: (id: GenerationId) => Promise<void>},
): GenerationRegistryPort {
	const store = options.store ?? keyvalStore();
	const address = generationAddress(name);

	const stateOf = (records: unknown[], canonical: unknown): GenerationRegistryState => ({
		generations: records as GenerationRecord[],
		canonical: canonical as GenerationId | undefined,
	});

	return {
		async read() {
			return store('readonly', (objectStore) =>
				Promise.all([
					promisifyRequest<unknown[]>(objectStore.getAll(address.entries)),
					promisifyRequest<unknown>(objectStore.get(address.canonical)),
				]).then(([records, canonical]) => stateOf(records, canonical)),
			);
		},

		async commit(plan) {
			return store(
				'readwrite',
				(objectStore) =>
					new Promise<void>((resolve, reject) => {
						Promise.all([
							promisifyRequest<unknown[]>(objectStore.getAll(address.entries)),
							promisifyRequest<unknown>(objectStore.get(address.canonical)),
						]).then(([records, canonical]) => {
							try {
								const write = plan(stateOf(records, canonical));
								if (!write) {
									resolve();
									return;
								}
								for (const id of write.remove ?? []) {
									objectStore.delete(address.entry(id));
								}
								if (write.put) {
									objectStore.put(write.put, address.entry(write.put));
								}
								if (write.canonical) {
									// ONE small record, and the whole of promotion. It carries the
									// identity alone: a copy of the record here would be a second
									// opinion about a generation the entry level already holds.
									objectStore.put(
										{stream: write.canonical.stream, processor: write.canonical.processor},
										address.canonical,
									);
								}
								resolve(promisifyRequest(objectStore.transaction));
							} catch (error) {
								reject(error);
							}
						}, reject);
					}),
			);
		},

		/**
		 * The stream digests present under this name, as a SCOPED LISTING of ONE
		 * LEVEL.
		 *
		 * A key cursor over the name's range that JUMPS to the next digest as soon
		 * as it has seen one, so this costs one read per stream rather than one per
		 * segment -- which is what makes running it on every open free, and it is
		 * what the hierarchical address bought. `[..., digest, []]` is above every
		 * key in that digest's subtree, because IndexedDB orders an array after any
		 * number or string.
		 */
		async listStreamDigests() {
			return store(
				'readonly',
				(objectStore) =>
					new Promise<string[]>((resolve, reject) => {
						const digests: string[] = [];
						const request = objectStore.openKeyCursor(streamsUnder(name));
						request.onerror = () => reject(request.error);
						request.onsuccess = () => {
							const cursor = request.result;
							if (!cursor) {
								resolve(digests);
								return;
							}
							const digest = (cursor.key as IDBValidKey[])[2];
							if (typeof digest === 'string') {
								digests.push(digest);
							}
							// no duplicate is possible: this jump lands ABOVE every key of the
							// digest just seen, so each one is visited exactly once
							cursor.continue(['stream', name, digest, []] as IDBValidKey);
						};
					}),
			);
		},

		async dropStreamSubtree(digest) {
			// A scoped `delete` per key in ONE transaction, never `idb-keyval`'s
			// `clear()`, which wipes the WHOLE object store and with it every other
			// stream, every other indexer name and this registry's own records.
			return store('readwrite', (objectStore) =>
				promisifyRequest<IDBValidKey[]>(objectStore.getAllKeys(streamSubtree(name, digest).subtree)).then((keys) => {
					for (const key of keys) {
						objectStore.delete(key);
					}
					return promisifyRequest(objectStore.transaction).then(() => keys.length);
				}),
			);
		},

		dropState(id) {
			return options.dropState(id);
		},
	};
}

/**
 * What a BROWSER holds by default: the previous generation, and the new one.
 *
 * Two, transiently, and not N. A browser keeps the previous generation only
 * until the new one is promoted, which is exactly what story 1 needs (the app
 * keeps rendering while the successor builds) and what makes the revert of story
 * 4 available for as long as the reconfigure is fresh. A server or a CLI should
 * be far more generous, because keeping generations to inspect, A/B-test and
 * revert is the POINT there; that runtime sets its own, and this constant is not
 * it.
 *
 * It is a CONFIGURED number, and the one thing it must never be is derived from
 * `navigator.storage.estimate()`: WebKit does not implement it, `quota` varies
 * four-fold between engines and moves between runs on one engine, and with a
 * real quota forced down to 8 MB it still reported 6.45 GB of headroom while
 * writes were failing (`work/notes/findings/browser-storage-headroom-for-generations.md`).
 * Nothing in this package consults it. The measured size is what makes two
 * comfortable anyway: 31,332 real logs occupy roughly 2 MB stored, because
 * IndexedDB compresses event payloads six- to ten-fold.
 */
export const BROWSER_GENERATION_CAPS: GenerationCaps = {maxGenerations: 2, maxStreams: 2};

export type BrowserGenerationRegistryOptions = {
	/**
	 * How this deployment drops the state store a generation folded into.
	 *
	 * Required, and injected rather than derived, because WHERE a generation's
	 * state lives is decided by the container above `StateStore` -- a later task
	 * -- and a registry that invented a database-naming convention here would
	 * fork one the rest of the system does not share. On the IndexedDB default
	 * that is `indexedDB.deleteDatabase(...)` of whatever the host named it.
	 */
	dropState: (id: GenerationId) => Promise<void>;
	/** Overrides for `BROWSER_GENERATION_CAPS`. */
	caps?: Partial<GenerationCaps>;
	/**
	 * The `idb-keyval` store to keep the records in. Defaults to the shared one,
	 * which is the one the stream keeper writes into -- deliberately, since the
	 * sweep has to SEE those subtrees.
	 */
	store?: UseStore;
};

/**
 * Open the generation registry for one named indexer, in IndexedDB.
 *
 * Opening it SWEEPS every stream subtree under this name that no registered
 * generation claims, which is how a placeholder-era subtree -- unreachable,
 * counted against no cap, and beyond the reach of ordinary reaping because it
 * has no generation whose departure could fire it -- is finally disposed of. The
 * sweep is scoped to this name's level of the address, so another indexer's
 * streams are not merely spared, they are never enumerated.
 */
export function openGenerationRegistryOnIndexedDB(
	name: string,
	options: BrowserGenerationRegistryOptions,
): Promise<GenerationRegistry> {
	return openGenerationRegistry(generationRegistryPortOnIndexedDB(name, options), {
		...BROWSER_GENERATION_CAPS,
		...options.caps,
	});
}
