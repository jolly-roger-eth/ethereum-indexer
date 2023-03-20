// mostly from npm package `react-use-svelte-store`
import {useEffect, useState} from 'react';

// ------------------------------------------------------------------------------------------------
// From svelte
// ------------------------------------------------------------------------------------------------
type Subscriber<T> = (value: T) => void;
type Unsubscriber = () => void;
type Updater<T> = (value: T) => T;
type Invalidator<T> = (value?: T) => void;
type StartStopNotifier<T> = (set: Subscriber<T>) => Unsubscriber | void;
interface Readable<T> {
	subscribe(this: void, run: Subscriber<T>, invalidate?: Invalidator<T>): Unsubscriber;
}
interface Writable<T> extends Readable<T> {
	set(this: void, value: T): void;
	update(this: void, updater: Updater<T>): void;
}

export type StoreSetter<T> = (v: T) => void;
export type StoreUpdateFn<T> = (v: T) => T;
export type StoreUpdater<T> = (u: StoreUpdateFn<T>) => void;

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
