import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {describe, expect, it} from 'vitest';
import {keepStateOnFile} from '../src/storage/state/OnFile.js';

// ---------------------------------------------------------------------------
// The fs keeper's BigInt round trip, asserted on TYPE
// ---------------------------------------------------------------------------
// A persisted `LastSync` genuinely carries both kinds at once: `unconfirmedBlocks`
// holds decoded `LogEvent`s whose `args` have a BigInt per `uint256`, and the
// same document holds `context` digests and whatever strings the contract
// emitted. The `"123n"` convention this replaced rendered `123n` and `"123n"`
// identically, so a value-only assertion passed while the type was swapped.
// ---------------------------------------------------------------------------

const CONTEXT: any = {
	source: {chainId: '8453', contracts: [{abi: [], address: '0x01', startBlock: 0}]},
	version: 'v1',
};

function payload() {
	return {
		state: {total: 2n ** 200n, label: '0n'},
		lastSync: {
			lastFromBlock: 0,
			lastToBlock: 10,
			latestBlock: 10,
			context: {source: [{startBlock: 0, hash: 'h1x9tbhn'}], config: '123n', processor: 'h8918n'},
			unconfirmedBlocks: [
				{
					number: 10,
					hash: '0xaa',
					events: [{args: {value: 123n, memo: '123n', zero: 0n, zeroish: '0n', neg: -5n, negish: '-5n'}}],
				},
			],
		},
	};
}

function tempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'etherfold-fs-keeper-'));
}

describe('keepStateOnFile', () => {
	it('round-trips real BigInts and look-alike strings in one document, types intact', async () => {
		const keeper = keepStateOnFile(tempDir(), 'state');
		await keeper.save(CONTEXT, payload() as any);

		const fetched: any = await keeper.fetch(CONTEXT);
		const args = fetched.lastSync.unconfirmedBlocks[0].events[0].args;
		expect(args.value).toBe(123n);
		expect(typeof args.value).toBe('bigint');
		expect(args.memo).toBe('123n');
		expect(typeof args.memo).toBe('string');
		expect(args.zero).toBe(0n);
		expect(typeof args.zero).toBe('bigint');
		expect(args.zeroish).toBe('0n');
		expect(typeof args.zeroish).toBe('string');
		expect(args.neg).toBe(-5n);
		expect(args.negish).toBe('-5n');
		expect(typeof args.negish).toBe('string');
		expect(fetched.state.total).toBe(2n ** 200n);
		expect(fetched.state.label).toBe('0n');
		expect(typeof fetched.state.label).toBe('string');
		expect(fetched.lastSync.context.config).toBe('123n');
		expect(typeof fetched.lastSync.context.config).toBe('string');
	});

	it('writes the tag, and writes a look-alike string as itself', async () => {
		const folder = tempDir();
		const keeper = keepStateOnFile(folder, 'state');
		await keeper.save(CONTEXT, payload() as any);

		const file = fs.readdirSync(folder).find((f) => f.endsWith('.json'))!;
		const raw = fs.readFileSync(path.join(folder, file), 'utf-8');
		expect(raw).toContain('"value":{"__bigint__":"123"}');
		expect(raw).toContain('"memo":"123n"');
		expect(raw).not.toContain('"value":"123n"');
	});

	it('leaves a legacy `"123n"` blob as strings rather than guessing at it', async () => {
		// The recorded decision: the suffix form is not read. It is not translated
		// (that would be the same guess under a new name) and it is not refused
		// value-by-value (that would refuse legitimate event data). A blob written
		// by an older build parses, and its BigInts are the strings they now are.
		const folder = tempDir();
		const keeper = keepStateOnFile(folder, 'state');
		await keeper.save(CONTEXT, payload() as any);
		const file = path.join(folder, fs.readdirSync(folder).find((f) => f.endsWith('.json'))!);
		fs.writeFileSync(file, JSON.stringify({state: {total: '123n'}, lastSync: {lastToBlock: 1}}));

		const fetched: any = await keeper.fetch(CONTEXT);
		expect(fetched.state.total).toBe('123n');
		expect(typeof fetched.state.total).toBe('string');
	});
});
