import {
	createSegmentedStream,
	resolveStreamConfig,
	streamDigestOf,
	type Abi,
	type ExistingStream,
	type IndexingSource,
	type StoredSegment,
	type StreamCursorRecord,
	type StreamSegmentPort,
	type UsedStreamConfig,
} from '@etherfold/core';
import {createStore, del, get, promisifyRequest, type UseStore} from 'idb-keyval';
import {logs} from 'named-logs';

const namedLogger = logs('@etherfold/browser');

/**
 * `idb-keyval`'s DEFAULT database and object store, re-derived.
 *
 * `defaultGetStore` is module-private, so naming the two strings is the ONLY way
 * to get a `UseStore` -- the escape hatch `createStore` returns, and the only
 * route to a key RANGE -- over the very store the bare `get`/`set` calls reach.
 * That is load-bearing rather than incidental. A keeper that quietly opened a
 * store of its own would never SEE the legacy blob it is required to delete, it
 * would make "an unrelated key in the same store survives `clear`" vacuous, and
 * it would remove the whole ground for banning `idb-keyval`'s `clear()`, which
 * is dangerous exactly BECAUSE the stream shares one store with everything else
 * this package writes.
 */
export const KEYVAL_DATABASE = 'keyval-store';
export const KEYVAL_OBJECT_STORE = 'keyval';

/** The leading literal, so the stream keyspace cannot be a prefix of another. */
const STREAM = 'stream';
/** The cursor record's own position in the subtree, beside the ordinals. */
const CURSOR = 'cursor';

/**
 * One stream's address: a HIERARCHICAL array key, plus the flat key it replaces.
 *
 * ```
 * ['stream', <indexer-name>, <streamDigest>, <ordinal>]   a segment
 * ['stream', <indexer-name>, <streamDigest>, 'cursor']    the cursor record
 * ```
 *
 * An earlier design packed these components into one delimited STRING and then
 * needed an anchored regex, a cross-chain corruption hazard (`stream_tag_1` is a
 * prefix of `stream_tag_10_0`), a temp-name rule and an extra keeper operation.
 * All of that was a consequence of the flat namespace: comparing key ELEMENTS
 * cannot confuse chain `1` with chain `10`, so the hazard is gone rather than
 * guarded. There is no string-prefix matching anywhere below.
 *
 * The DIGEST level is `@etherfold/core`'s `streamDigestOf`: what the stream
 * CONTAINS -- its fetch filter and its stream config -- and nothing about who
 * indexed it. `chainId` is not a level of its own because that digest already
 * covers it (its block-0 skeleton entry hashes `chainId` and `genesisHash`), and
 * `<indexer-name>` is the caller-supplied discriminator, untouched here. This
 * level held a `chain-<chainId>` PLACEHOLDER while the digest was being built;
 * subtrees written under it are simply unreachable now, and disposing of them
 * belongs to the sweep in the generation registry, which is the only place that
 * can know which digests are registered.
 */
export function streamAddress<ABI extends Abi>(
	name: string,
	source: IndexingSource<ABI>,
	streamConfig: UsedStreamConfig,
) {
	const prefix: IDBValidKey[] = [STREAM, name, streamDigestOf(source, streamConfig)];
	return {
		prefix,
		cursor: [...prefix, CURSOR] as IDBValidKey,
		segment: (ordinal: number) => [...prefix, ordinal] as IDBValidKey,
		/**
		 * The two ranges, which are NOT the same and using the wrong one is a real bug.
		 *
		 * IndexedDB orders `number < string < array`. So the SUBTREE range, whose
		 * upper bound is an empty ARRAY, spans the `'cursor'` record along with the
		 * ordinals -- which is what `clear` wants and what keeps the cursor from being
		 * orphaned by a scoped delete. A SEGMENTS-ONLY read has to exclude the string
		 * bound, or a full ordered scan would come back with the cursor record sitting
		 * in it as though it were a segment.
		 */
		segments: IDBKeyRange.bound([...prefix, 0], [...prefix, CURSOR], false, true),
		subtree: IDBKeyRange.bound([...prefix, 0], [...prefix, []]),
		/** The SHIPPED keeper's flat key, which is deleted rather than adopted. */
		legacy: `${STREAM}_${name}_${source.chainId}`,
	};
}

/**
 * `idb-keyval`'s default store, opened once for this module.
 *
 * Memoised the way `idb-keyval` memoises its own, so a page holding several
 * named indexers does not hold one IndexedDB connection per keeper.
 */
let sharedStore: UseStore | undefined;
function keyvalStore(): UseStore {
	if (!sharedStore) {
		sharedStore = createStore(KEYVAL_DATABASE, KEYVAL_OBJECT_STORE);
	}
	return sharedStore;
}

/**
 * The five substrate operations, over one `UseStore` and one stream's subtree.
 *
 * The two writes are RAW `readwrite` transactions that read the cursor and write
 * both records, and NOT `get` followed by `setMany`: `setMany` opens its own
 * transaction, so the read would be a separate one, and two tabs saving at once
 * would both read next-ordinal `5`, both `put` segment `5`, and one batch would
 * be lost -- with the ordinals still CONTIGUOUS, so no later check could ever
 * detect it. IndexedDB serialises overlapping `readwrite` transactions on one
 * object store, across tabs, so that is all the mutual exclusion this needs.
 * `@etherfold/state-store-indexeddb`'s `idb.ts` is the repo's precedent,
 * including its rule that inside a transaction you may await only IndexedDB's
 * own promises.
 */
function portOver<ABI extends Abi>(
	name: string,
	store: UseStore,
	streamConfig: () => UsedStreamConfig,
): StreamSegmentPort<ABI> {
	const addressOf = (source: IndexingSource<ABI>) => streamAddress(name, source, streamConfig());

	return {
		async readCursor(source) {
			const address = addressOf(source);
			return store('readonly', (objectStore) =>
				promisifyRequest<StreamCursorRecord<ABI> | undefined>(objectStore.get(address.cursor)),
			);
		},

		async readSegments(source) {
			const address = addressOf(source);
			// A KEY RANGE, never `keys()`: that reads every key in the store, so with
			// several streams it costs O(store) per load rather than O(stream).
			// `getAllKeys` and `getAll` answer in key order, which for this range is
			// ORDINAL order, which is APPEND order.
			return store('readonly', (objectStore) =>
				Promise.all([
					promisifyRequest<IDBValidKey[]>(objectStore.getAllKeys(address.segments)),
					promisifyRequest<unknown[]>(objectStore.getAll(address.segments)),
				]).then(([keys, values]) =>
					keys.map((key, i): StoredSegment => ({ordinal: (key as IDBValidKey[])[3] as number, value: values[i]})),
				),
			);
		},

		async commitSegmentWithCursor(source, allocate) {
			const address = addressOf(source);
			return store(
				'readwrite',
				(objectStore) =>
					new Promise<void>((resolve, reject) => {
						const request = objectStore.get(address.cursor);
						request.onerror = () => reject(request.error);
						request.onsuccess = () => {
							try {
								const commit = allocate(request.result as StreamCursorRecord<ABI> | undefined);
								if (!commit) {
									resolve();
									return;
								}
								objectStore.put(commit.segment, address.segment(commit.ordinal));
								objectStore.put(commit.cursor, address.cursor);
								resolve(promisifyRequest(objectStore.transaction));
							} catch (error) {
								reject(error);
							}
						};
					}),
			);
		},

		async writeCursorOnly(source, next) {
			const address = addressOf(source);
			return store(
				'readwrite',
				(objectStore) =>
					new Promise<void>((resolve, reject) => {
						const request = objectStore.get(address.cursor);
						request.onerror = () => reject(request.error);
						request.onsuccess = () => {
							try {
								const record = next(request.result as StreamCursorRecord<ABI> | undefined);
								if (!record) {
									resolve();
									return;
								}
								objectStore.put(record, address.cursor);
								resolve(promisifyRequest(objectStore.transaction));
							} catch (error) {
								reject(error);
							}
						};
					}),
			);
		},

		async clearSubtree(source) {
			const address = addressOf(source);
			// A scoped `delete` per key in ONE transaction, never `idb-keyval`'s
			// `clear()`, which wipes the WHOLE object store and with it every other
			// stream and every other keeper's rows. That is a capability, not the
			// implementation of `ExistingStream.clear`.
			return store('readwrite', (objectStore) =>
				promisifyRequest<IDBValidKey[]>(objectStore.getAllKeys(address.subtree)).then((keys) => {
					for (const key of keys) {
						objectStore.delete(key);
					}
					return promisifyRequest(objectStore.transaction).then(() => keys.length);
				}),
			);
		},
	};
}

/**
 * The cached event stream, as an APPEND-ONLY log of segments in IndexedDB.
 *
 * A save writes its BATCH as a new segment at the next ordinal, together with
 * the cursor record, in ONE transaction, and nothing already written is ever
 * touched again -- so appending costs the batch and not the history. The shipped
 * keeper read the whole stream, concatenated and wrote all of it back on every
 * `saveNewEvents`, which made a backfill quadratic and charged an EMPTY batch the
 * same price purely to move `lastSync`.
 *
 * The rules are `@etherfold/core`'s `createSegmentedStream`; this module supplies
 * the substrate: the address, the key ranges and the transaction. `store` is
 * injectable so a test can WRAP the object store and count the work a save does,
 * which is the only honest place to measure it now that the commit is a raw
 * transaction rather than a call to `set`.
 */
export function keepStreamOnIndexedDB<ABI extends Abi>(
	name: string,
	options: {store?: UseStore} = {},
): ExistingStream<ABI> & {setStreamConfig: (streamConfig: UsedStreamConfig) => void} {
	const store = options.store ?? keyvalStore();
	/**
	 * The config half of the stream's IDENTITY, which the indexer hands over in
	 * its `reinit` (`setStreamConfig`) before it asks for anything.
	 *
	 * It starts at the RESOLVED DEFAULT rather than at nothing, so a keeper driven
	 * directly -- a test, a tool -- addresses the same stream an indexer given no
	 * `stream` config would, instead of a fourth thing. It is a single mutable
	 * value on purpose: one keeper serves one indexer, and a reconfigure MOVES it
	 * to the new stream, which is exactly what leaves the old subtree intact.
	 */
	let streamConfig = resolveStreamConfig(undefined);
	const segmented = createSegmentedStream<ABI>(portOver<ABI>(name, store, () => streamConfig));

	/**
	 * The shipped keeper's blob is DELETED, not adopted, and it is detected HERE
	 * rather than only in `clear`.
	 *
	 * `indexer.ts`'s state-kept branch guards its `clear` behind
	 * `if (existingStreamData)`, so a blob found only by `clear` would survive
	 * indefinitely. Adopting it in place would spare a re-index for users who do
	 * not exist (`CONTEXT.md`: nothing is published), and it would drag a
	 * read-cursor precedence rule and a set of ordinal carve-outs along with it.
	 * Anything beside it in the new subtree goes too: the two together are not one
	 * stream, and half of each is worse than neither.
	 */
	async function dropLegacyBlob(source: IndexingSource<ABI>): Promise<boolean> {
		const address = streamAddress(name, source, streamConfig);
		const legacy = await get(address.legacy, store);
		if (legacy === undefined) {
			return false;
		}
		await del(address.legacy, store);
		await segmented.clear(source);
		namedLogger.info(
			`the cached stream at ${address.legacy} is in the old whole-blob format: it has been DELETED rather than ` +
				`adopted, and the stream will be rebuilt from the chain.`,
		);
		return true;
	}

	return {
		setStreamConfig(next) {
			streamConfig = next;
		},
		async fetchFrom(source, fromBlock) {
			if (await dropLegacyBlob(source)) {
				return undefined;
			}
			return segmented.fetchFrom(source, fromBlock);
		},
		saveNewEvents(source, stream) {
			return segmented.saveNewEvents(source, stream);
		},
		async clear(source) {
			await del(streamAddress(name, source, streamConfig).legacy, store);
			await segmented.clear(source);
		},
	};
}
