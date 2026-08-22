import {Abi, isBigIntLiteral, simple_hash, LastSync, ProcessorContext} from '@etherfold/core';

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
				// The test is the WHOLE value. `value.endsWith('n')` also matched every
				// ordinary string ending in n, and the `try` only hid the damage: a
				// digits-then-n string that was never a BigInt (a base36 hash such as
				// `123n`, and the sync context is full of hashes) came back as a BigInt,
				// silently changing its type and so its comparisons.
				const parsed = JSON.parse(fromStorage, (_, value) =>
					isBigIntLiteral(value) ? BigInt(value.slice(0, -1)) : value,
				);
				return parsed;
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
			localStorage.setItem(
				storageID,
				JSON.stringify({...all, __VERSION__: context.version}, (_, value) =>
					typeof value === 'bigint' ? value.toString() + 'n' : value,
				),
			);
		},
		clear: async (context: ProcessorContext<ABI, ProcessorConfig>) => {
			const storageID = getStorageID(name, context.source.chainId, 'config' in context ? context.config : undefined);
			localStorage.removeItem(storageID);
		},
	};
}
