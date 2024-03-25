import {Abi, AllData, simple_hash, LastSync, ProcessorContext} from 'ethereum-indexer';
import { storage } from '../../utils/fs';

function getStorageID<ProcessorConfig = undefined>(name: string, chainId: string, config: ProcessorConfig) {
	const configHash = config ? simple_hash(config) : undefined;
	return `${name}_${chainId}${configHash ? `_${configHash}` : ''}`;
}

type StateData<ABI extends Abi, ProcessResultType, Extra> = AllData<ABI, ProcessResultType, Extra>;

export type IndexedStateLocation = {url: string} | {prefix: string};



export function keepStateOnFile<ABI extends Abi, ProcessResultType, ProcessorConfig>(
	folder: string,
	name: string
) {
	const {get,set,del} = storage(folder);
	return {
		fetch: async (context: ProcessorContext<ABI, ProcessorConfig>) => {
			const storageID = getStorageID(name, context.source.chainId, 'config' in context ? context.config : undefined);
			
			const existingState = await get<StateData<ABI, ProcessResultType, unknown>>(storageID)

			return existingState;
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
			await del(storageID)
		},
	};
}
