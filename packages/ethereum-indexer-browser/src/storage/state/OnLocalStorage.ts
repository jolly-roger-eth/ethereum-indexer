import {Abi, simple_hash, LastSync, ProcessorContext} from 'ethereum-indexer';

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
				const parsed = JSON.parse(fromStorage, (_, value) => {
					if (typeof value === 'string' && value.endsWith('n')) {
						try {
							const bn = BigInt(value.slice(0, -1));
							return bn;
						} catch (err) {
							return value;
						}
					} else {
						return value;
					}
				});
				return parsed;
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
			localStorage.setItem(
				storageID,
				JSON.stringify({...all, __VERSION__: context.version}, (_, value) =>
					typeof value === 'bigint' ? value.toString() + 'n' : value
				)
			);
		},
		clear: async (context: ProcessorContext<ABI, ProcessorConfig>) => {
			const storageID = getStorageID(name, context.source.chainId, 'config' in context ? context.config : undefined);
			localStorage.removeItem(storageID);
		},
	};
}
