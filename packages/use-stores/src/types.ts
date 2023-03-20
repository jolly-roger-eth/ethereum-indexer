// ------------------------------------------------------------------------------------------------
// Types from react
// ------------------------------------------------------------------------------------------------
type DependencyList = ReadonlyArray<unknown>;
type Destructor = () => void;
type EffectCallback = () => void | Destructor;
export type UseEffect = (effect: EffectCallback, deps?: DependencyList) => void;

type Dispatch<A> = (value: A) => void;
type SetStateAction<S> = S | ((prevState: S) => S);
export type UseState = <S>(initialState: S | (() => S)) => [S, Dispatch<SetStateAction<S>>];
// ------------------------------------------------------------------------------------------------

// ------------------------------------------------------------------------------------------------
// Types from svelte
// ------------------------------------------------------------------------------------------------
type Subscriber<T> = (value: T) => void;
type Unsubscriber = () => void;
type Updater<T> = (value: T) => T;
type Invalidator<T> = (value?: T) => void;
type StartStopNotifier<T> = (set: Subscriber<T>) => Unsubscriber | void;
export interface Readable<T> {
	subscribe(this: void, run: Subscriber<T>, invalidate?: Invalidator<T>): Unsubscriber;
}
export interface Writable<T> extends Readable<T> {
	set(this: void, value: T): void;
	update(this: void, updater: Updater<T>): void;
}
// ------------------------------------------------------------------------------------------------

export type StoreSetter<T> = (v: T) => void;
export type StoreUpdateFn<T> = (v: T) => T;
export type StoreUpdater<T> = (u: StoreUpdateFn<T>) => void;
