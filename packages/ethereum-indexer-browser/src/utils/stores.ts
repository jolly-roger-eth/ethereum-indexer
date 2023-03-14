import {writable, type Readable} from 'sveltore';

export function createStore<T extends {[field: string]: unknown}>(
	$state: T
): {
	set(data: Partial<T>): void;
	readonly $state: T;
	readable: Readable<T> & {
		$state: T;
		acknowledgeError(): void;
	};
} {
	const store = writable($state);
	function set(data: Partial<T>) {
		for (const field of Object.keys(data)) {
			($state as any)[field] = data[field];
		}
		store.set($state);
	}
	return {
		set,
		$state,
		readable: {
			$state,
			subscribe: store.subscribe,
			acknowledgeError() {
				(set as any)({error: undefined});
			},
		},
	};
}

export function createRootStore<T>(initialState: T) {
	let $state = initialState;
	const store = writable<T>($state);
	function set(newState: T) {
		$state = newState;
		store.set($state);
	}

	return {
		set,
		get $state() {
			return $state;
		},
		readable: {
			get $state() {
				return $state;
			},
			subscribe: store.subscribe,
		},
	};
}
