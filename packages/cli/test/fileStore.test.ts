import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {BLOB_SNAPSHOT_FORMAT} from '@etherfold/core';
import {prepareIndexing} from '../src/index.js';
import type {Options} from '../src/types.js';
import {ALICE, BOB, fakeChain, jsObjectModule, START_BLOCK, transfer, ZERO} from './utils/chain.js';

// ---------------------------------------------------------------------------------------------------
// `--store file` KEEPS THE FREE-FORM PATH, ON THE NEW ENGINE
// ---------------------------------------------------------------------------------------------------
// The engine changed underneath (`LogFetcher` -> `createDirectIngestion` ->
// `StreamBuilder` rather than `EthereumIndexer`), and what a user sees must not:
// the same untagged module, the same folder, the same snapshot envelope, and a
// second run that resumes from it.
//
// It is the same wiring the entity arm uses, which is the claim worth checking
// rather than asserting: `StreamBuilder` takes an `EventProcessor`, and both
// processor kinds are one -- so a `keepState` processor survives the swap.
// ---------------------------------------------------------------------------------------------------

const LOGS = [
	transfer(START_BLOCK + 10, '0xa10', ZERO, ALICE, 1n),
	transfer(START_BLOCK + 90, '0xa90', ALICE, BOB, 1n),
];
const TIP = START_BLOCK + 100;

const folders: string[] = [];
function tempFolder(): string {
	const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'etherfold-cli-file-'));
	folders.push(folder);
	return folder;
}

afterEach(() => {
	for (const folder of folders.splice(0)) {
		fs.rmSync(folder, {recursive: true, force: true});
	}
});

function optionsFor(folder: string): Options {
	return {processor: './nfts.js', nodeUrl: 'http://localhost:0', store: 'file', folder};
}

function snapshotIn(folder: string): any {
	const files = fs.readdirSync(folder).filter((name) => !name.includes('lastSync'));
	expect(files.length).toBe(1);
	return JSON.parse(fs.readFileSync(path.join(folder, files[0]), 'utf-8'));
}

describe('--store file', () => {
	it('writes the free-form state through the keepState keeper, in the envelope it always wrote', async () => {
		const folder = tempFolder();
		const chain = fakeChain().serve(LOGS, TIP);
		const prepared = await prepareIndexing(optionsFor(folder), {
			importModule: async () => jsObjectModule,
			provider: chain.provider,
			sleep: async () => {},
		});
		await prepared.index();

		// no store on this path: the keeper persists the whole object in one keyed
		// write, which is how a blob gets atomicity
		expect(prepared.store).toBeUndefined();

		const snapshot = snapshotIn(folder);
		expect(snapshot.format).toBe(BLOB_SNAPSHOT_FORMAT);
		expect(snapshot.state).toEqual({transfers: 2, owners: {'1': BOB}});
		expect(snapshot.lastSync.lastToBlock).toBe(TIP);
	});

	it('resumes from the saved snapshot on a second run', async () => {
		const folder = tempFolder();
		await (
			await prepareIndexing(optionsFor(folder), {
				importModule: async () => jsObjectModule,
				provider: fakeChain().serve(LOGS, TIP).provider,
				sleep: async () => {},
			})
		).index();

		const resumed = fakeChain().serve(LOGS, TIP);
		await (
			await prepareIndexing(optionsFor(folder), {
				importModule: async () => jsObjectModule,
				provider: resumed.provider,
				sleep: async () => {},
			})
		).index();

		// the second run asked from inside the unconfirmed window, not from the start
		// block, and the state did not double-count the events it re-read
		expect(resumed.logRanges[0].from).toBeGreaterThan(START_BLOCK);
		expect(snapshotIn(folder).state).toEqual({transfers: 2, owners: {'1': BOB}});
	});
});
