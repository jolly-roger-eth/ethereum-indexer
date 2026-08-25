import {Abi, AllData, simple_hash, LastSync, ProcessorContext, taggedBnReviver} from '@etherfold/core';
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
 * A snapshot published by an older build is not translated: it comes back with
 * its BigInts as the `"123n"` strings they now are. Note the gap that leaves,
 * because it is KNOWN rather than overlooked: a published state file DOES carry
 * a format number (`SNAPSHOT_FORMAT`, which the CLI's keeper bumped to 2 for
 * exactly this) and nothing here reads it, so a legacy remote snapshot is
 * installed as state rather than refused the way the CLI refuses it locally.
 * Closing that means the number has to live somewhere both packages can see it,
 * which is a seam decision rather than a line of code, and a bare remote
 * `lastSync` file has no format to check at all. Re-publish rather than
 * translate.
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
					let latest: {index: number; lastSync?: LastSync<Abi>} | undefined;
					for (let i = 0; i < remote.length; i++) {
						if (typeof remote[i] === 'string' || 'url' in remote[i]) {
							const urlOfRemote = getURL(remote[i], context);
							try {
								const response = await fetch(urlOfRemote);
								const text = await response.text();
								const json: {
									state: ProcessResultType;
									lastSync: LastSync<Abi>;
								} = JSON.parse(text, taggedBnReviver);

								if (
									!latest ||
									!latest.lastSync ||
									(json.lastSync && json.lastSync.lastToBlock > latest.lastSync.lastToBlock)
								) {
									latest = {
										index: i,
										lastSync: json.lastSync,
									};
								}
							} catch (err) {
								console.error(`failed to fetch remote lastSync`, err);
							}
						} else {
							const urlOfLastSync = getURL(remote[i], context, true);
							try {
								const response = await fetch(urlOfLastSync);
								const text = await response.text();
								const json: LastSync<Abi> = JSON.parse(text, taggedBnReviver);
								if (!latest || !latest.lastSync || json.lastToBlock > latest.lastSync.lastToBlock) {
									latest = {
										index: i,
										lastSync: json,
									};
								}
							} catch (err) {
								console.error(`failed to fetch remote lastSync`, err);
							}
						}
					}

					if (
						existingState &&
						latest &&
						latest.lastSync &&
						latest.lastSync.lastToBlock < existingState.lastSync.lastToBlock
					) {
						// console.log(`Existing State`)
						return existingState;
					}

					if (!latest) {
						console.error(`could not fetch any valid lastSync, still continue with first`);
						latest = {
							index: 0,
						};
					}
					// else {
					// 	console.log(`Using ${latest.index}`)
					// }
					const url = getURL(remote[latest.index], context);
					// console.log(`fetching ${url}`);
					try {
						const response = await fetch(url);
						const text = await response.text();
						const json = JSON.parse(text, taggedBnReviver);
						remoteState = json;
					} catch (err) {
						console.error(`failed to fetch remote-state, try second`, err);

						const url = getURL(remote[(latest.index + 1) % remote.length], context);
						try {
							const response = await fetch(url);
							const text = await response.text();
							const json = JSON.parse(text, taggedBnReviver);
							remoteState = json;
						} catch (err) {
							console.error(`failed to fetch second remote-state`, err);
							// TODO more than 2
						}
					}
				} else {
					const url = getURL(remote, context);
					// console.log(`fetching single remote ${url}`);
					try {
						const response = await fetch(url);
						const text = await response.text();
						const json = JSON.parse(text, taggedBnReviver);
						remoteState = json;
					} catch (err) {
						console.error(`failed to fetch remote-state`, err);
					}
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
