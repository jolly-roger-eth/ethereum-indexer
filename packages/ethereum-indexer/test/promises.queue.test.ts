import {describe, expect, it} from 'vitest';
import {createAction} from '../src/internal/utils/promises';

// These tests pin down the intended behaviour of `next()` (mode 'queue'):
// when an execution is in-flight, a subsequent `next()` must be QUEUED to run
// AFTER the current one completes - not started immediately/concurrently.
describe('createAction - queue (next) serialization', () => {
	it('does not start the queued execution until the in-flight one completes', async () => {
		const events: string[] = [];
		// Trigger that finishes the first (pending) execution. Typed as a zero-arg
		// function because it captures the resolution value in its closure.
		let resolveFirst!: () => void;

		const action = createAction<string, number>((args) => {
			const id = args as number;
			events.push(`start:${id}`);
			if (id === 1) {
				return new Promise<string>((res) => {
					resolveFirst = () => {
						events.push(`finish:1`);
						res('first');
					};
				});
			}
			events.push(`finish:${id}`);
			return Promise.resolve(`done:${id}`);
		});

		const p1 = action.next(1); // starts, stays pending
		const p2 = action.next(2); // should be QUEUED behind p1

		// Give microtasks a chance to run. If the second execution were started
		// immediately (the bug), we'd already see 'start:2' here.
		await Promise.resolve();
		await Promise.resolve();
		expect(events).toEqual(['start:1']);

		resolveFirst();
		const [r1, r2] = await Promise.all([p1, p2]);

		expect(r1).toBe('first');
		expect(r2).toBe('done:2');
		// The second execution must run strictly after the first finishes.
		expect(events).toEqual(['start:1', 'finish:1', 'start:2', 'finish:2']);
	});

	it('executes each queued call exactly once', async () => {
		const starts: number[] = [];
		let resolveFirst!: () => void;

		const action = createAction<string, number>((args) => {
			const id = args as number;
			starts.push(id);
			if (id === 1) {
				return new Promise<string>((res) => {
					resolveFirst = () => res('first');
				});
			}
			return Promise.resolve(`done:${id}`);
		});

		const p1 = action.next(1);
		const p2 = action.next(2);

		resolveFirst();
		await Promise.all([p1, p2]);

		// Each id should have been executed exactly once (no duplicates from fall-through).
		expect(starts.filter((x) => x === 1)).toHaveLength(1);
		expect(starts.filter((x) => x === 2)).toHaveLength(1);
	});
});
