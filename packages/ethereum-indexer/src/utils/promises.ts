// TODO make it a library

type ResolveFunction<T> = (value: T | PromiseLike<T>) => void;
type RejectFunction = (reason?: any) => void;

// export type RejectablePromise<T> = PromiseLike<T> & {
// 	reject(err: any): void;
// 	rejected: boolean;
// };

// export class RejectablePromiseAlreadyRejectedError extends Error {
// 	constructor() {
// 		super('RejectablePromiseAlreadyRejectedError');
// 	}
// }

// export class RejectablePromiseRejected extends Error {
// 	constructor() {
// 		super('RejectablePromiseRejected');
// 	}
// }

export type CancellablePromise<T> = PromiseLike<T> & {
	cancel(): void;
	cancelled: boolean;
	// cancellable: boolean;
	completed: boolean;
};

// export class CancellablePromiseError extends Error {
// 	constructor() {
// 		super('CancellablePromiseError');
// 	}
// }

export class CancellablePromiseCancelled extends Error {
	constructor() {
		super('CancellablePromiseCancelled');
	}
}

// export function createRejectablePromise<T>(
// 	executor: (resolve: ResolveFunction<T>, reject: RejectFunction) => void
// ): RejectablePromise<T> {
// 	const promise = new Promise<T>((resolve, reject) => {
// 		let rejected = false;
// 		function rejectIfNotRejectedAlready(err: any) {
// 			if (!rejected) {
// 				rejected = true;
// 				reject(err);
// 			}
// 		}
// 		function resolveIfNotRejectedAlready(result: T | PromiseLike<T>) {
// 			if (!rejected) {
// 				resolve(result);
// 			}
// 		}

// 		(promise as any).reject = () => {
// 			if (rejected) {
// 				throw new RejectablePromiseAlreadyRejectedError();
// 			} else {
// 				rejected = true;
// 				reject(new RejectablePromiseRejected());
// 			}
// 		};
// 		executor(resolveIfNotRejectedAlready, rejectIfNotRejectedAlready);

// 		Object.defineProperty(promise, 'rejected', {
// 			get: function () {
// 				return rejected;
// 			},
// 		});
// 	});

// 	return promise as PromiseLike<T> as RejectablePromise<T>;
// }

// type OnePromiseArgFn<T> = T extends void ? () => void : (arg: Promise<T>) => void;
// type UnlessCancelledFunction = <U>(...a: Parameters<OnePromiseArgFn<U>>) => U extends undefined ? void : Promise<U>;

export type UnlessCancelledFunction = <T>(arg: Promise<T>) => Promise<T>;

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
	// let cancellable = true;
	let completed = false;

	function rejectIfNotCancelledAlready(err: any) {
		if (!cancelled && !completed) {
			// cancellable = false;
			completed = true;
			reject(err);
		}
	}
	function resolveIfNotCancelledAlready(result: T | PromiseLike<T>) {
		if (!cancelled && !completed) {
			// cancellable = false;
			completed = true;
			resolve(result);
		}
	}

	function cancel() {
		// if (!cancellable) {
		// 	throw new CancellablePromiseError();
		// }
		if (!cancelled) {
			cancelled = true;
			// cancellable = false;
			reject(new CancellablePromiseCancelled());
			if (onCancel) {
				onCancel();
			}
		}
	}

	// function rejectIfCancelled(): void {
	// 	if (cancelled) {
	// 		throw new CancellablePromiseCancelled();
	// 	}
	// }
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
	// Object.defineProperty(promise, 'cancellable', {
	// 	get: function () {
	// 		return cancellable;
	// 	},
	// });
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

export function createAction<T, U = undefined, C = undefined>(
	execute: U extends undefined
		? (action: ActionOperations<T>) => void | Promise<T>
		: (args: U, action: ActionOperations<T>) => void | Promise<T>
) {
	let _context: C | undefined;
	let _promise: CancellablePromise<T> | undefined;
	let _blocked: boolean = false;

	function _execute(mode: 'queue' | 'wait' | 'force' | 'once' = 'wait', args: U) {
		if (_blocked) {
			throw new Error('Blocked');
		}
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
								const result = (execute as any)(args ? args : promiseAction, args ? promiseAction : undefined);
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
			const result = (execute as any)(args ? args : promiseAction, args ? promiseAction : undefined);
			if (result) {
				result.then(resolve).catch(reject);
			}
		});
		return _promise;
	}

	return {
		next: (args: U) => _execute('queue', args),
		ifNotExecuting: (args: U) => _execute('wait', args), // ifNotExecuting args is ignored if first execited
		now: (args: U) => _execute('force', args),
		once: (args: U) => _execute('once', args), // once args is ignored if first execited
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

// // TEST
// const action = createPromiseAction<number>(({resolve, unlessCancelled}) => {
// 	console.log('hello');
// 	resolve(1);
// });
// action.once();

// const action2 = createPromiseAction<number, string>(({resolve, unlessCancelled}, args) => {
// 	resolve(1);
// 	console.log(args);
// });
// action2.once('hello');

// export function createARunOnceAtATime<T>() {
// 	let _promise: CancellablePromise<T> | undefined;

// 	return {
// 		promise(
// 			execute: (
// 				resolve: ResolveFunction<T>,
// 				reject: RejectFunction,
// 				unlessCancelled: <U>(p: Promise<U>) => Promise<U>,
// 				cancel: () => void
// 			) => void,
// 			mode: 'queue' | 'wait' | 'force' | 'once' = 'wait'
// 		) {
// 			if (_promise) {
// 				if (_promise.completed) {
// 					if (mode === 'once') {
// 						return _promise;
// 					}
// 				} else if (!_promise.cancelled) {
// 					if (mode === 'force') {
// 						_promise.cancel();
// 					} else if (mode === 'queue') {
// 						const p = _promise;
// 						_promise = _promise.then(() => {
// 							return createCancellablePromise(
// 								(resolve, reject, unlessCancelled, cancel) => {
// 									execute(resolve, reject, unlessCancelled, cancel);
// 								},
// 								() => {
// 									p.cancel();
// 								}
// 							);
// 						}) as CancellablePromise<T>;
// 					} else {
// 						return _promise;
// 					}
// 				}
// 			}
// 			_promise = createCancellablePromise((resolve, reject, unlessCancelled, cancel) => {
// 				execute(resolve, reject, unlessCancelled, cancel);
// 			});
// 			return _promise;
// 		},
// 	};
// }

// ------------------------------------------------------------------------------------------------
// EXPERIMENTAL HELPERS
// ------------------------------------------------------------------------------------------------
// export function createManageablePromise<
// 	U = unknown,
// 	T extends PromiseLike<U> = PromiseLike<U>,
// 	P extends [ResolveFunction<U>, RejectFunction, ...any[]] = [resolve: ResolveFunction<U>, reject: RejectFunction]
// >(factory: (executor: (...p: P) => void) => T, callbacks?: {onResolve: ResolveFunction<U>; onReject: RejectFunction}) {
// 	let _promise: T | undefined;
// 	let _resolve: ResolveFunction<U> | undefined;
// 	let _reject: RejectFunction | undefined;
// 	function clear(): {reject: RejectFunction; resolve: ResolveFunction<U>} | undefined {
// 		if (_promise) {
// 			const past = {reject: _reject as RejectFunction, resolve: _resolve as ResolveFunction<U>};
// 			_promise = undefined;
// 			_resolve = undefined;
// 			_reject = undefined;
// 			return past;
// 		}
// 		return undefined;
// 	}
// 	return {
// 		promise(execute?: (...args: P) => void) {
// 			if (_promise) {
// 				return _promise;
// 			}
// 			_promise = factory((resolve, reject, ...args) => {
// 				_resolve = resolve;
// 				_reject = reject;
// 				if (execute) {
// 					(execute as any)(...args);
// 				}
// 			});
// 			return _promise;
// 		},
// 		reject(err: unknown) {
// 			if (_reject) {
// 				clear()?.reject(err);
// 				callbacks?.onReject(err);
// 			}
// 		},
// 		resolve(value: U) {
// 			if (_resolve) {
// 				clear()?.resolve(value);
// 				callbacks?.onResolve(value);
// 			}
// 		},
// 	};
// }

// this help with types
// TODO can typescript handle it
// export function createManageableCancellablePromise<T>() {
// 	return createManageablePromise<
// 		T,
// 		CancellablePromise<T>,
// 		Parameters<Parameters<typeof createCancellablePromise<T>>[0]>
// 	>(createCancellablePromise);
// }

// // type TTT = CancellablePromise<
// const test = createManageablePromise<
// 	string,
// 	CancellablePromise<string>,
// 	Parameters<Parameters<typeof createCancellablePromise<string>>[0]>
// >(createCancellablePromise);

// export function testPromise(seconds: number): Promise<string> {
// 	return new Promise((resolve) => setTimeout(() => resolve('hello'), seconds * 1000));
// }

// test.promise(async (resolve, reject, unlessCancelled) => {
// 	const t = await unlessCancelled(testPromise(2));
// 	console.log(t);
// 	resolve('dsds');
// });

// const p = createCancellablePromise(async (resolve, reject, unlessCancelled) => {
// 	const t = await unlessCancelled(testPromise(2));
// 	console.log(t);
// 	resolve('dsds');
// });

// const test2 = createManageableCancellablePromise();
// test2.promise(async (resolve, reject, unlessCancelled) => {
// 	const t = await unlessCancelled(testPromise(2));
// 	console.log(t);
// 	resolve('dsds');
// });
