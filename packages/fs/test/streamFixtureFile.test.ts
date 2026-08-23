import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {describe, expect, it} from 'vitest';
import type {Abi} from '@etherfold/core';
import {STREAM_FIXTURE_FORMAT, type StreamFixture} from '@etherfold/core';
import {loadStreamFixture, saveStreamFixture} from '../src/storage/stream/Fixture.js';

const FIXTURE: StreamFixture<Abi> = {
	format: STREAM_FIXTURE_FORMAT,
	provenance: {capturedAt: '2026-08-22T00:00:00.000Z', chainId: '8453', fromBlock: 1, toBlock: 2},
	source: {chainId: '8453', contracts: [{abi: [] as unknown as Abi, address: '0x01', startBlock: 1}]},
	lastSync: {
		context: {source: [{startBlock: 0, hash: 'h1'}], config: 'h2', processor: ''},
		latestBlock: 2,
		lastFromBlock: 1,
		lastToBlock: 2,
		unconfirmedBlocks: [],
	},
	eventStream: [
		{
			blockNumber: 1,
			blockHash: '0xaa',
			transactionIndex: 0,
			removed: false,
			address: '0x01',
			data: '0x',
			topics: [],
			transactionHash: '0xbb',
			logIndex: 0,
			extra: undefined,
			eventName: 'Transfer',
			args: {value: 2n ** 200n},
		} as any,
	],
};

function tempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'etherfold-fixture-'));
}

describe('a fixture on disk', () => {
	it('round-trips, BigInts included', () => {
		const file = path.join(tempDir(), 'stream.json');
		saveStreamFixture(file, FIXTURE);

		const loaded = loadStreamFixture(file);
		expect((loaded.eventStream[0] as any).args.value).toBe(2n ** 200n);
		expect(loaded.provenance).toEqual(FIXTURE.provenance);
		// Indented by default: a committed artifact gets read and diffed.
		expect(fs.readFileSync(file, 'utf-8').split('\n').length).toBeGreaterThan(1);
	});

	it('gzips when the path says .gz, and reads it back the same', () => {
		const folder = tempDir();
		const plain = path.join(folder, 'stream.json');
		const gzipped = path.join(folder, 'stream.json.gz');
		saveStreamFixture(plain, FIXTURE);
		saveStreamFixture(gzipped, FIXTURE);

		// Not JSON on disk any more...
		expect(() => JSON.parse(fs.readFileSync(gzipped, 'utf-8'))).toThrow();
		expect(fs.statSync(gzipped).size).toBeLessThan(fs.statSync(plain).size);
		// ... but the same fixture coming back out.
		expect(loadStreamFixture(gzipped)).toEqual(loadStreamFixture(plain));
	});

	it('names the file when the contents are not a fixture', () => {
		const file = path.join(tempDir(), 'not-a-fixture.json');
		fs.writeFileSync(file, '{"format":99}');
		expect(() => loadStreamFixture(file)).toThrow(/not-a-fixture\.json: unsupported stream fixture format/);
	});
});
