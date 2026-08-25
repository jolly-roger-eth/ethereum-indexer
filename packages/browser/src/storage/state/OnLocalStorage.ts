import {Abi, simple_hash, LastSync, ProcessorContext, taggedBnReplacer, taggedBnReviver} from '@etherfold/core';

function getStorageID<ProcessorConfig = undefined>(name: string, chainId: string, config: ProcessorConfig) {
	const configHash = config ? simple_hash(config) : undefined;
	return `${name}_${chainId}${configHash ? `_${configHash}` : ''}`;
}

export function keepStateOnLocalStorage<ABI extends Abi, ProcessResultType, ProcessorConfig>(name: string) {
	return {
		fetch: async (context: ProcessorContext<ABI, ProcessorConfig>) => {
			const storageID = getStorageID(name, context.source.chainId, 'config' in context ? context.config : undefined);
			const fromStorage = localStorage.getItem(storageID);
			if (!fromStorage) {
				return undefined;
			} else {
				// BigInts are TAGGED (`{__bigint__: "123"}`), through the core's one
				// codec. This used to suffix them with `n` and revive anything that read
				// that way, which is a guess it cannot win: `"123n"` is both what `123n`
				// serializes to and a legal string for a contract to emit, and a stored
				// blob carries decoded event args and `context` digests side by side.
				//
				// A blob written by an older build is NOT translated: its BigInts come
				// back as the `"123n"` strings they now are. localStorage carries no
				// format number to refuse on, and it is a cache whose recovery is a
				// re-index; `clear()` is the way out.
				return JSON.parse(fromStorage, taggedBnReviver);
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
			localStorage.setItem(storageID, JSON.stringify({...all, __VERSION__: context.version}, taggedBnReplacer));
		},
		clear: async (context: ProcessorContext<ABI, ProcessorConfig>) => {
			const storageID = getStorageID(name, context.source.chainId, 'config' in context ? context.config : undefined);
			localStorage.removeItem(storageID);
		},
	};
}
