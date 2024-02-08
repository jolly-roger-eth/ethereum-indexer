import {Abi, AllData, simple_hash, LastSync, ProcessorContext} from 'ethereum-indexer';
import {contextFilenames} from 'ethereum-indexer-utils';
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
							// console.log(`raw url, do not fetch lastSync`);
							continue;
						}
						const urlOfLastSync = getURL(remote[i], context, true);
						try {
							const response = await fetch(urlOfLastSync);
							const json: LastSync<Abi> = await response.json();
							if (!latest || !latest.lastSync || json.lastToBlock > latest.lastSync.lastToBlock) {
								latest = {
									index: i,
									lastSync: json
								}
							}
						} catch (err) {
							console.error(`failed to fetch remote lastSync`, err);
						}
					}

					if (existingState && latest && latest.lastSync && latest.lastSync.lastToBlock < existingState.lastSync.lastToBlock) {
						// console.log(`Existing State`)
						return existingState;
					}

					if (!latest) {
						console.error(`could not fetch any valid lastSync, still continue with first`);
						latest = {
							index: 0
						}
					}
					const url = getURL(remote[latest.index], context);
					try {
						const response = await fetch(url);
						const json = await response.json();
						remoteState = json;
					} catch (err) {
						console.error(`failed to fetch remote-state, try second`, err);
						
						const url = getURL(remote[(latest.index + 1) % remote.length], context);
						try {
							const response = await fetch(url);
							const json = await response.json();
							remoteState = json;
						} catch(err) {
							console.error(`failed to fetch second remote-state`, err);
							// TODO more than 2
						}
					}
				} else {
					const url = getURL(remote, context);
					try {
						const response = await fetch(url);
						const json = await response.json();
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
