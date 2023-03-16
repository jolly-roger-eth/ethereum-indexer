export type RejectablePromise<T> = Promise<T> & {
	reject(err: any): void;
	rejected: boolean;
};

export class RejectablePromiseAlreadyRejectedError extends Error {
	constructor() {
		super('RejectablePromiseAlreadyRejectedError');
	}
}

export class RejectablePromiseRejected extends Error {
	constructor() {
		super('RejectablePromiseRejected');
	}
}

export type CancellablePromise<T> = Promise<T> & {
	cancel(): void;
	cancelled: boolean;
	cancellable: boolean;
};

export class CancellablePromiseError extends Error {
	constructor() {
		super('CancellablePromiseError');
	}
}

export function createRejectablePromise<T>(
	executor: (resolve: (value: T | PromiseLike<T>) => void, reject: (reason?: any) => void) => void
): RejectablePromise<T> {
	const promise = new Promise<T>((resolve, reject) => {
		let rejected = false;
		function rejectIfNotRejectedAlready(err: any) {
			if (!rejected) {
				rejected = true;
				reject(err);
			}
		}
		function resolveIfNotRejectedAlready(result: T) {
			if (!rejected) {
				resolve(result);
			}
		}

		(promise as any).reject = () => {
			if (rejected) {
				throw new RejectablePromiseAlreadyRejectedError();
			} else {
				rejected = true;
				reject(new RejectablePromiseRejected());
			}
		};
		executor(resolveIfNotRejectedAlready, rejectIfNotRejectedAlready);

		Object.defineProperty(promise, 'rejected', {
			get: function () {
				return rejected;
			},
		});
	});

	return promise as RejectablePromise<T>;
}

export function createCancellablePromise<T>(
	executor: (resolve: (value: T | PromiseLike<T>) => void, reject: (reason?: any) => void, cancel: () => void) => void,
	onCancel?: () => void
): CancellablePromise<T> {
	const promise = new Promise<T>((resolve, reject) => {
		let cancelled = false;
		let cancellable = true;
		function rejectIfNotCancelledAlready(err: any) {
			if (!cancelled) {
				cancellable = false;
				reject(err);
			}
		}
		function resolveIfNotCancelledAlready(result: T) {
			if (!cancelled) {
				cancellable = false;
				resolve(result);
			}
		}

		function cancel() {
			if (!cancellable) {
				throw new CancellablePromiseError();
			}
			if (!cancelled) {
				cancelled = true;
				if (onCancel) {
					onCancel();
				}
			}
		}
		(promise as any).cancel = cancel;
		Object.defineProperty(promise, 'cancelled', {
			get: function () {
				return cancelled;
			},
		});
		Object.defineProperty(promise, 'cancellable', {
			get: function () {
				return cancellable;
			},
		});
		executor(resolveIfNotCancelledAlready, rejectIfNotCancelledAlready, cancel);
	});

	return promise as CancellablePromise<T>;
}
