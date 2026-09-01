import {
	Abi,
	AllData,
	BLOB_SNAPSHOT_FORMAT,
	isReadableBlobSnapshot,
	simple_hash,
	LastSync,
	ProcessorContext,
	taggedBnReviver,
} from '@etherfold/core';
// the subpath, not the barrel: the barrel re-exports the CLI-side modules, whose
// top-level `node:fs` / `node:path` / `node:module` imports make this package
// unbundleable for a browser. See the note at the top of `utils/src/indexer.ts`.
import {contextFilenames} from '@etherfold/utils/indexer';
import {get, set, del} from 'idb-keyval';

function getStorageID<ProcessorConfig = undefined>(name: string, chainId: string, config: ProcessorConfig) {
	const configHash = config ? simple_hash(config) : undefined;
	return `${name}_${chainId}${configHash ? `_${configHash}` : ''}`;
}

type StateData<ABI extends Abi, ProcessResultType, Extra> = AllData<ABI, ProcessResultType, Extra>;

export type IndexedStateLocation = {url: string} | {prefix: string};

function getURL(remote: IndexedStateLocation | string, context: ProcessorContext<Abi, any>, lastSync = false) {
	let url: string;
	if (typeof remote === 'string') {
		url = remote;
	} else if ('url' in remote) {
		url = remote.url;
	} else {
		const {stateFile, lastSyncFile} = contextFilenames(context);
		if (lastSync) {
			url = remote.prefix + lastSyncFile;
		} else {
			url = remote.prefix + stateFile;
		}
	}
	return url;
}

/**
 * Fetch the snapshot a mirror publishes, REFUSING an encoding this build cannot
 * read rather than installing it.
 *
 * The file is `@etherfold/cli`'s keeper's envelope, `{format, processor,
 * savedAt, lastSync, state, history}`, and the format number says which BigInt
 * convention the bytes are in. It lives in `@etherfold/core`
 * (`BLOB_SNAPSHOT_FORMAT`) rather than with the writer, because this package
 * cannot depend on the CLI's (a tab must be able to bundle this code, which
 * `bundlesForABrowser.test.ts` pins) and a second constant here kept in step
 * with the CLI's by attention is the outcome the shared home exists to avoid.
 *
 * A format this build does not recognise -- 1, or the bare pre-envelope form
 * that reads as `undefined` -- is not translated and not mined for the fields
 * that happen to be recognisable: translating is the guess ADR-0029 removed,
 * and a snapshot understood in part is state a client cannot tell apart from
 * state understood fully. So it is refused as a whole, LOUDLY (the location and
 * both numbers, so a mis-published mirror is diagnosable from the tab), and the
 * caller's recovery ladder takes over: the next mirror, then local state, then
 * a cold start. That is the same answer the CLI's own reader gives the same
 * bytes locally, where its recovery is the cold start alone.
 */
async function fetchReadableSnapshot<ABI extends Abi, ProcessResultType, ProcessorConfig>(
	remote: IndexedStateLocation | string,
	context: ProcessorContext<ABI, ProcessorConfig>,
): Promise<StateData<ABI, ProcessResultType, unknown> | undefined> {
	const url = getURL(remote, context);
	try {
		const response = await fetch(url);
		const text = await response.text();
		const json: unknown = JSON.parse(text, taggedBnReviver);
		if (!isReadableBlobSnapshot<ABI, ProcessResultType>(json)) {
			// See the note above: refused whole, never translated, never half-read.
			console.error(
				`the snapshot at ${url} is format ${(json as any)?.format}, and this build reads ` +
					`${BLOB_SNAPSHOT_FORMAT}: refusing it. Installing it would resume from a state whose ` +
					`every uint256 had quietly become a string, so this mirror cannot serve this client.`,
			);
			return undefined;
		}
		return json as unknown as StateData<ABI, ProcessResultType, unknown>;
	} catch (err) {
		console.error(`failed to fetch remote-state at ${url}`, err);
		return undefined;
	}
}

/**
 * State kept in IndexedDB, optionally hydrated from a published snapshot.
 *
 * ## Which half of this needs a BigInt convention
 *
 * Not the local one. `idb-keyval` hands the whole object to IndexedDB, whose
 * structured clone stores a BigInt AS a BigInt, so nothing is encoded there. It
 * is the REMOTE snapshots -- JSON over HTTP, written by `@etherfold/cli`'s
 * keeper -- that cross a text boundary, and every `JSON.parse` below therefore
 * goes through `taggedBnReviver`, the core's one codec.
 *
 * That codec TAGS a BigInt as `{__bigint__: "123"}`. The reads here used to
 * suffix it with `n` and revive anything that read that way, which cannot be
 * made correct: `"123n"` is both what `123n` serializes to and a legal string
 * for a contract to emit, so the decoder guessed, and a snapshot carries decoded
 * event args and `context` digests in one document.
 *
 * ## A snapshot this build cannot read is refused, and the refusal has a ladder
 *
 * A published snapshot carries a format number, and it is now CHECKED here as it
 * already was on the CLI's own reader (which is why that reader cold starts on a
 * format-1 file while this one, for too long, installed the same bytes and
 * indexed on top of `uint256`s that had quietly become `"123n"` strings). An
 * unreadable mirror is a mirror that cannot serve this client, so it is treated
 * exactly as an unreachable one already is: skipped when it loses, failed over
 * from when it wins. Local state that is already ahead still wins over any
 * remote, readable or not. What is never done is translating an older format:
 * the translation IS the guess ADR-0029 ruled out. Re-publish rather than
 * translate.
 *
 * ## The bare `lastSync` file is selection data only
 *
 * `getURL(remote, context, true)` fetches a prefix-form mirror's separate
 * `lastSync` file to compare mirrors before downloading any payload, and that
 * file carries NO format -- the CLI writes it bare beside the enveloped state
 * file. It is read without a format check, deliberately: the one field used
 * from it is `lastToBlock`, a plain number identical under every encoding of
 * the envelope, and nothing from it is ever installed. The file that IS
 * installed is the state file, which carries the check, so a stale head can
 * mis-order the mirrors but cannot smuggle an unreadable payload past them.
 * Refusing the head instead would make every mirror the CLI publishes
 * unselectable, which is a guard placed where the damage is not.
 */
export function keepStateOnIndexedDB<ABI extends Abi, ProcessResultType, ProcessorConfig>(
	name: string,
	remote?: IndexedStateLocation | string | IndexedStateLocation[],
) {
	return {
		fetch: async (context: ProcessorContext<ABI, ProcessorConfig>) => {
			const storageID = getStorageID(name, context.source.chainId, 'config' in context ? context.config : undefined);
			const existingState = await get<StateData<ABI, ProcessResultType, unknown>>(storageID);

			let remoteState: StateData<ABI, ProcessResultType, unknown> | undefined;
			if (remote) {
				if (Array.isArray(remote)) {
					// SELECTION: ask each mirror how far it has got, installing nothing. A
					// mirror's POSITION is all that is compared, so that is all this holds.
					let latest: {index: number; lastSync?: {lastToBlock: number}} | undefined;
					for (let i = 0; i < remote.length; i++) {
						if (typeof remote[i] === 'string' || 'url' in remote[i]) {
							// The location IS the snapshot, so comparing means downloading it
							// -- which is also where an unreadable one is refused, BEFORE it
							// can win selection on a block number this build cannot read.
							const json = await fetchReadableSnapshot<ABI, ProcessResultType, ProcessorConfig>(remote[i], context);
							if (
								json &&
								(!latest ||
									!latest.lastSync ||
									(json.lastSync && json.lastSync.lastToBlock > latest.lastSync.lastToBlock))
							) {
								latest = {index: i, lastSync: json.lastSync};
							}
						} else {
							// the bare `lastSync` file: selection data only (see the module note)
							const urlOfLastSync = getURL(remote[i], context, true);
							try {
								const response = await fetch(urlOfLastSync);
								const text = await response.text();
								const json: LastSync<Abi> = JSON.parse(text, taggedBnReviver);
								if (!latest || !latest.lastSync || json.lastToBlock > latest.lastSync.lastToBlock) {
									latest = {index: i, lastSync: json};
								}
							} catch (err) {
								console.error(`failed to fetch remote lastSync at ${urlOfLastSync}`, err);
							}
						}
					}

					if (
						existingState &&
						latest &&
						latest.lastSync &&
						latest.lastSync.lastToBlock < existingState.lastSync.lastToBlock
					) {
						// Local state is already ahead of every mirror: keep it, exactly as
						// a client with usable local state must not be dragged back by a
						// stale published file, readable or not.
						return existingState;
					}

					if (!latest) {
						console.error(`could not fetch any valid lastSync, still continue with first`);
						latest = {
							index: 0,
						};
					}
					remoteState = await fetchReadableSnapshot<ABI, ProcessResultType, ProcessorConfig>(
						remote[latest.index],
						context,
					);
					if (!remoteState) {
						// The winner could not serve this client -- unreachable, or an
						// encoding this build refuses -- so fail over to the next mirror,
						// exactly as an unreachable winner already is. (Still one step:
						// walking every remaining candidate is the entity path's
						// behaviour, `bootstrapFromSnapshot`; converging the two belongs
						// to the free-form path's retirement, not to this fix.)
						remoteState = await fetchReadableSnapshot<ABI, ProcessResultType, ProcessorConfig>(
							remote[(latest.index + 1) % remote.length],
							context,
						);
					}
				} else {
					remoteState = await fetchReadableSnapshot<ABI, ProcessResultType, ProcessorConfig>(remote, context);
				}
			}

			if (!existingState) {
				return remoteState;
			} else {
				if (remoteState && remoteState.lastSync.lastToBlock >= existingState.lastSync.lastToBlock) {
					return remoteState;
				}
				return existingState;
			}
		},
		save: async (
			context: ProcessorContext<ABI, ProcessorConfig>,
			all: {
				state: ProcessResultType;
				lastSync: LastSync<ABI>;
			},
		) => {
			const storageID = getStorageID(name, context.source.chainId, 'config' in context ? context.config : undefined);
			await set(storageID, {...all, __VERSION__: context.version});
		},
		clear: async (context: ProcessorContext<ABI, ProcessorConfig>) => {
			const storageID = getStorageID(name, context.source.chainId, 'config' in context ? context.config : undefined);
			await del(storageID);
		},
	};
}
