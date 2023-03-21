import type {Readable, StoreSetter, StoreUpdater, UseEffect, UseState, Writable} from './types';

export type ReactHooks = {useState: UseState; useEffect: UseEffect};

const unset: any = Symbol();

function reactiveReadable(react: ReactHooks): <T>(store: Readable<T>, immutable?: boolean) => T {
	return function <T>(store: Readable<T>, immutable = true) {
		const [value, set] = react.useState<T>(unset as unknown as T);
		react.useEffect(
			() =>
				store.subscribe((v) => {
					if (immutable) {
						return v;
					}
					// as v might be a mutated value we do the following:
					// for array and object we ensure a new object is created so react detect the changes
					if (Array.isArray(v)) {
						return set([...v] as T);
					} else if (typeof v === 'object') {
						return set({...v});
					}
					return set(v);
				}),
			[store]
		);
		let valueToReturn = value;
		if (valueToReturn === unset) {
			store.subscribe((v) => {
				valueToReturn = v;
			})();
		}
		return valueToReturn;
	};
}

function reactiveWriteable(
	react: ReactHooks
): <T>(store: Writable<T>, immutable?: boolean) => [T, StoreSetter<T>, StoreUpdater<T>] {
	return <T>(store: Writable<T>, immutable = true) => {
		const value = reactiveReadable(react)(store, immutable);
		return [value, store.set, store.update];
	};
}

export function useStores(react: ReactHooks): {
	useWriteable<T>(store: Writable<T>, immutable?: boolean): [T, StoreSetter<T>, StoreUpdater<T>];
	useReadable<T>(store: Readable<T>, immutable?: boolean): T;
} {
	return {
		useReadable: reactiveReadable(react),
		useWriteable: reactiveWriteable(react),
	};
}
