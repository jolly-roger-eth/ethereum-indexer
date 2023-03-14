import type {EIP1193Provider, EIP1193Request} from 'eip-1193';

export function queuedProvider(ethereum: EIP1193Provider) {
	const callQueue: {
		args: EIP1193Request;
		resolve: (result: any) => void;
		reject: (error: any) => void;
		pending: boolean;
	}[] = [];
	(window as any).queue = callQueue;
	function process() {
		if (callQueue.length > 0) {
			const request = callQueue[0];
			if (!request.pending) {
				request.pending = true;
				ethereum
					.request(request.args)
					.then((v) => {
						request.resolve(v);
						callQueue.shift();
						process();
					})
					.catch((err) => {
						request.reject(err);
						callQueue.shift();
						process();
					});
			}
		}
	}
	return new Proxy(ethereum, {
		get(target, p, receiver) {
			if (p === 'request') {
				return (args: {method: string; params?: readonly unknown[]}) => {
					if (args.method === 'eth_call') {
						const promise = new Promise((resolve, reject) => {
							callQueue.push({args: args as EIP1193Request, resolve, reject, pending: false});
						});
						process();
						return promise;
					} else {
						return target[p](args as any);
					}
				};
			}
			return (target as any)[p];
		},
	});
}
