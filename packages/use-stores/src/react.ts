import {useEffect, useState} from 'react';

import type {Readable, StoreSetter, StoreUpdater, Writable} from './types';

const unset: any = Symbol();

export function useReadable<T>(store: Readable<T>): T {
	const [value, set] = useState<T>(unset as unknown as T);

	useEffect(() => store.subscribe(set), [store]);

	let valueToReturn = value;
	if (valueToReturn === unset) {
		store.subscribe((v) => {
			valueToReturn = v;
		})();
	}

	return valueToReturn;
}

export function useWritable<T>(store: Writable<T>): [T, StoreSetter<T>, StoreUpdater<T>] {
	const value = useReadable(store);
	return [value, store.set, store.update];
}
