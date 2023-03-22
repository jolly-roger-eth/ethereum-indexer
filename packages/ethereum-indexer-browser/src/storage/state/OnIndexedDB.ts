import {Abi, AllData, hash, LastSync, ProcessorContext} from 'ethereum-indexer';
import {get, set, del} from 'idb-keyval';

function getStorageID<ProcessorConfig = undefined>(name: string, chainId: string, config: ProcessorConfig) {
	const configHash = config ? hash(config) : undefined;
	return `${name}_${chainId}${configHash ? `_${configHash}` : ''}`;
}

type StateData<ABI extends Abi, ProcessResultType, Extra> = AllData<ABI, ProcessResultType, Extra>;

export function keepStateOnIndexedDB<ABI extends Abi, ProcessResultType, ProcessorConfig>(name: string) {
	return {
		fetch: async (context: ProcessorContext<ABI, ProcessorConfig>) => {
			const storageID = getStorageID(name, context.source.chainId, 'config' in context ? context.config : undefined);
			const existingState = await get<StateData<ABI, ProcessResultType, unknown>>(storageID);
			if (!existingState) {
				return undefined;
			} else {
				return existingState;
			}
		},
		save: async (
			context: ProcessorContext<ABI, ProcessorConfig>,
			all: {
				data: ProcessResultType;
				lastSync: LastSync<ABI>;
			}
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
