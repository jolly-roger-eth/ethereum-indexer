import {describe, expect, it} from 'vitest';
import {createAction} from '../src/internal/utils/promises';

describe('createAction - argument passing', () => {
	it('passes a truthy object arg through to the executor', async () => {
		let received: any;
		const action = createAction<string, {value: number}>((args, _ops) => {
			received = args;
			return Promise.resolve('ok');
		});
		const result = await action.next({value: 42});
		expect(result).toBe('ok');
		expect(received).toEqual({value: 42});
	});

	it('passes a falsy-but-valid arg (0) through instead of swallowing it', async () => {
		// Regression: the old code branched on `args ? args : promiseAction`, so a 0 arg
		// caused the executor to receive the action operations object as its first arg.
		let received: any;
		const action = createAction<number, number>((args, _ops) => {
			received = args;
			return Promise.resolve((args as number) + 1);
		});
		const result = await action.next(0);
		expect(received).toBe(0);
		expect(result).toBe(1);
	});

	it('passes a falsy-but-valid arg (empty string) through', async () => {
		let received: any;
		const action = createAction<string, string>((args, _ops) => {
			received = args;
			return Promise.resolve(`[${args}]`);
		});
		const result = await action.next('');
		expect(received).toBe('');
		expect(result).toBe('[]');
	});

	it('passes a falsy-but-valid arg (false) through', async () => {
		let received: any;
		const action = createAction<string, boolean>((args, _ops) => {
			received = args;
			return Promise.resolve(String(args));
		});
		const result = await action.next(false);
		expect(received).toBe(false);
		expect(result).toBe('false');
	});

	it('still provides the action operations object as the second arg for arg-taking actions', async () => {
		let ops: any;
		const action = createAction<string, number>((_args, operations) => {
			ops = operations;
			return Promise.resolve('done');
		});
		await action.next(0);
		expect(ops).toBeDefined();
		expect(typeof ops.resolve).toBe('function');
		expect(typeof ops.reject).toBe('function');
		expect(typeof ops.unlessCancelled).toBe('function');
		expect(typeof ops.cancel).toBe('function');
	});

	it('passes the action operations as the FIRST arg for an arg-less action', async () => {
		let firstArg: any;
		const action = createAction<string>((operations) => {
			firstArg = operations;
			return Promise.resolve('noargs');
		});
		const result = await action.once();
		expect(result).toBe('noargs');
		// For an arg-less action, the first parameter must be the operations object.
		expect(typeof firstArg.resolve).toBe('function');
		expect(typeof firstArg.unlessCancelled).toBe('function');
	});

	it('forwards a falsy arg correctly when invoked via each public entry point', async () => {
		// Each entry point (next/ifNotExecuting/now/once) must forward a 0 arg, not the ops object.
		for (const entry of ['next', 'ifNotExecuting', 'now', 'once'] as const) {
			let received: any = 'unset';
			const action = createAction<number, number>((args) => {
				received = args;
				return Promise.resolve((args as number) + 1);
			});
			const result = await (action[entry] as (a: number) => Promise<number>)(0);
			expect(received, `entry: ${entry}`).toBe(0);
			expect(result, `entry: ${entry}`).toBe(1);
		}
	});
});
