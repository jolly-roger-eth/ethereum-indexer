import {describe, expect, it} from 'vitest';
import {main, run} from '../src/index.js';
import type {Options} from '../src/types.js';

const OPTIONS: Options = {
	processor: '/this/module/does/not/exist.js',
	nodeUrl: 'http://localhost:0',
	folder: '/tmp/ei-cli-main-test',
};

// ---------------------------------------------------------------------------
// Characterization (current behaviour of run() — should PASS as-is)
// ---------------------------------------------------------------------------

describe('run() — characterization (current behaviour)', () => {
	it('rejects when the processor module cannot be imported', async () => {
		await expect(run(OPTIONS)).rejects.toBeTruthy();
	});
});

// ---------------------------------------------------------------------------
// MEDIUM-1: the CLI must resolve a process exit code — 0 on success, 1 on
// failure — and must NOT print "DONE" on failure. Previously cli.ts did
// `run().then(() => console.log('DONE'))` with no .catch / no process.exit, so
// a failed index looked like success (and could leave the process lingering).
// `main()` encapsulates that contract with injectable collaborators.
// ---------------------------------------------------------------------------

describe('main() — exit-code contract (MEDIUM-1)', () => {
	it('exits 0 and logs DONE on success', async () => {
		const exits: number[] = [];
		const logs: any[] = [];
		await main(OPTIONS, {
			run: async () => undefined, // simulate a successful run
			exit: (code) => exits.push(code),
			log: (...a) => logs.push(a.join(' ')),
			error: () => {},
		});
		expect(exits).toEqual([0]);
		expect(logs).toContain('DONE');
	});

	it('exits 1, reports the error, and does NOT log DONE on failure', async () => {
		const exits: number[] = [];
		const logs: any[] = [];
		const errors: any[] = [];
		const boom = new Error('indexing failed');
		await main(OPTIONS, {
			run: async () => {
				throw boom;
			},
			exit: (code) => exits.push(code),
			log: (...a) => logs.push(a.join(' ')),
			error: (...a) => errors.push(a),
		});
		expect(exits).toEqual([1]);
		expect(logs).not.toContain('DONE');
		expect(errors.flat()).toContain(boom);
	});

	it('exits 1 when the real run() rejects (e.g. missing processor module)', async () => {
		const exits: number[] = [];
		await main(OPTIONS, {
			exit: (code) => exits.push(code),
			log: () => {},
			error: () => {},
		});
		expect(exits).toEqual([1]);
	});
});
