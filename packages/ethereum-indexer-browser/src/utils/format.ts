import type {Abi, LastSync} from 'ethereum-indexer';

export function formatLastSync<ABI extends Abi>(lastSync: LastSync<ABI>): any {
	return filterOutFieldsFromObject(lastSync, ['_rev', '_id', 'batch']);
}

export function filterOutFieldsFromObject<T = Object, U = Object>(obj: T, fields: string[]): U {
	const keys = Object.keys(obj as any);
	const newObj: U = {} as U;
	for (const key of keys) {
		if (fields.indexOf(key) !== -1) {
			continue;
		}
		(newObj as any)[key] = (obj as any)[key];
	}
	return newObj;
}
