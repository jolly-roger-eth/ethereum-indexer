type ResolveFunction<T> = (value: T | PromiseLike<T>) => void;
type RejectFunction = (reason?: any) => void;

export type CancellablePromise<T> = PromiseLike<T> & {
	cancel(): void;
	cancelled: boolean;
	completed: boolean;
};

export class CancellablePromiseCancelled extends Error {
	constructor() {
		super('CancellablePromiseCancelled');
	}
}

export type UnlessCancelledFunction = <T>(arg: Promise<T>) => Promise<T>;

/**
 *
 * @param executor function that receive the usual resolve and reject function
 * plus a unlessCancelled function that reject if the promise is already cancelled
 * and a cancel function that can be called to cancel the promise
 * @param onCancel an optional callback that is called when the promise is cancelled
 * @returns a promise with a cancel function along with 2 status getter `completed` and `cancelled`
 */
export function createCancellablePromise<T>(
	executor: (
		resolve: ResolveFunction<T>,
		reject: RejectFunction,
		unlessCancelled: UnlessCancelledFunction,
		cancel: () => void
	) => void,
	onCancel?: () => void
): CancellablePromise<T> {
	let resolve: ResolveFunction<T>;
	let reject: RejectFunction;
	let cancelled = false;
	let completed = false;

	function rejectIfNotCancelledAlready(err: any) {
		if (!cancelled && !completed) {
			completed = true;
			reject(err);
		}
	}
	function resolveIfNotCancelledAlready(result: T | PromiseLike<T>) {
		if (!cancelled && !completed) {
			completed = true;
			resolve(result);
		}
	}

	function cancel() {
		if (!cancelled) {
			cancelled = true;
			reject(new CancellablePromiseCancelled());
			if (onCancel) {
				onCancel();
			}
		}
	}

	function unlessCancelled<U>(p: Promise<U>): Promise<U> {
		return p.then((v) => {
			if (cancelled) {
				throw new CancellablePromiseCancelled();
			} else {
				return v;
			}
		});
	}

	const promise = new Promise<T>((a, b) => {
		resolve = a;
		reject = b;
		executor(
			resolveIfNotCancelledAlready,
			rejectIfNotCancelledAlready,
			unlessCancelled as UnlessCancelledFunction,
			cancel
		);
	});

	(promise as any).cancel = cancel;
	Object.defineProperty(promise, 'cancelled', {
		get: function () {
			return cancelled;
		},
	});
	Object.defineProperty(promise, 'completed', {
		get: function () {
			return completed;
		},
	});

	return promise as PromiseLike<T> as CancellablePromise<T>;
}

type Func<T, U> = U extends undefined ? () => Promise<T> : (args: U) => Promise<T>;

export type CancelOperations = {
	unlessCancelled: <P>(p: Promise<P>) => Promise<P>;
	cancel: () => void;
};

export type ActionOperations<T> = CancelOperations & {
	resolve: ResolveFunction<T>;
	reject: RejectFunction;
};

/**
 * An action is a special object that manage an underlying promise to ensure it is executed in a proper manner
 */
export function createAction<T, U = undefined, C = undefined>(
	execute: U extends undefined
		? (action: ActionOperations<T>) => void | Promise<T>
		: (args: U, action: ActionOperations<T>) => void | Promise<T>
) {
	let _context: C | undefined;
	let _promise: CancellablePromise<T> | undefined;
	let _blocked: boolean = false;

	function _execute(mode: 'queue' | 'wait' | 'force' | 'once' = 'wait', args?: U, hasArgs: boolean = false) {
		if (_blocked) {
			throw new Error('Blocked');
		}
		// Whether to forward `args` to the executor must be decided by whether an argument
		// was actually provided, NOT by its truthiness. Otherwise a falsy-but-valid arg
		// (0, '', false) would be dropped and the executor would receive the operations
		// object in the first slot instead.
		const callExecutor = (
			executeFn: (...a: any[]) => void | Promise<T>,
			promiseAction: ActionOperations<T>
		): void | Promise<T> => {
			return hasArgs ? executeFn(args, promiseAction) : executeFn(promiseAction);
		};
		if (_promise) {
			if (_promise.completed) {
				if (mode === 'once') {
					return _promise;
				}
			} else if (!_promise.cancelled) {
				if (mode === 'force') {
					_promise.cancel();
				} else if (mode === 'queue') {
					const p = _promise;
					// context is preserved in a queue
					_promise = _promise.then(() => {
						return createCancellablePromise(
							(resolve, reject, unlessCancelled, cancel) => {
								const promiseAction = {resolve, reject, unlessCancelled, cancel};
								const result = callExecutor(execute as any, promiseAction);
								if (result) {
									result.then(resolve).catch(reject);
								}
							},
							() => {
								p.cancel();
							}
						);
					}) as CancellablePromise<T>;
				} else {
					return _promise;
				}
			}
		}
		// we reset the context for each new promise;
		_context = undefined;
		_promise = createCancellablePromise((resolve, reject, unlessCancelled, cancel) => {
			const promiseAction = {resolve, reject, unlessCancelled, cancel};
			const result = callExecutor(execute as any, promiseAction);
			if (result) {
				result.then(resolve).catch(reject);
			}
		});
		return _promise;
	}

	return {
		next: (...a: [U] | []) => _execute('queue', a[0], a.length > 0),
		ifNotExecuting: (...a: [U] | []) => _execute('wait', a[0], a.length > 0), // ifNotExecuting args is ignored if first execited
		now: (...a: [U] | []) => _execute('force', a[0], a.length > 0),
		once: (...a: [U] | []) => _execute('once', a[0], a.length > 0), // once args is ignored if first execited
		cancel() {
			_promise?.cancel();
		},
		block() {
			_promise?.cancel();
			_blocked = true;
		},
		unblock() {
			_blocked = false;
		},
		reset() {
			if (_promise) {
				//} && _promise.cancellable) {
				_promise?.cancel();
			}
			_promise = undefined;
		},
		get executing() {
			if (_promise?.completed || _promise?.cancelled) {
				return undefined;
			}
			return _promise;
		},
		setContext(context: C) {
			_context = context;
		},
		getContext(): C | undefined {
			return _context;
		},
	} as unknown as {
		next: Func<T, U>;
		ifNotExecuting: Func<T, U>;
		now: Func<T, U>;
		once: Func<T, U>;
		cancel(): void;
		reset(): void;
		block(): void;
		unblock(): void;
		get executing(): Promise<T> | undefined;
		setContext(context: C): void;
		getContext(): C | undefined;
	};
}
