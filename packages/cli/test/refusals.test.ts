import {describe, expect, it} from 'vitest';
import {prepareIndexing} from '../src/index.js';
import type {Options} from '../src/types.js';
import {entityModule, jsObjectModule, noChain} from './utils/chain.js';

// ---------------------------------------------------------------------------------------------------
// A KIND/STORE MISMATCH IS REFUSED BEFORE ANY NETWORK CALL
// ---------------------------------------------------------------------------------------------------
// The processor KIND comes from the MODULE and `--store` comes from the command
// line, which is one fact each rather than two answers to one question. When
// they disagree the run is refused, naming both -- and it is refused at the same
// point in the sequence the keeper-less refusal was made at, which is BEFORE the
// source is resolved and therefore before `eth_chainId`.
//
// The provider here throws on every method, so "no network call was made" is
// checked by the test rather than asserted in prose.
// ---------------------------------------------------------------------------------------------------

const BASE = {processor: './processor.js', nodeUrl: 'http://localhost:0'};

describe('kind versus store', () => {
	it('refuses an entity processor on --store file, naming both', async () => {
		const chain = noChain();
		await expect(
			prepareIndexing({...BASE, store: 'file', folder: './state'} as Options, {
				importModule: async () => entityModule,
				provider: chain.provider,
			}),
		).rejects.toThrow(/'entities'.*--store file.*--store sqlite/s);
		expect(chain.calls).toEqual([]);
	});

	it('refuses a js-object processor on --store sqlite, naming both', async () => {
		const chain = noChain();
		await expect(
			prepareIndexing({...BASE, store: 'sqlite', db: ':memory:'} as Options, {
				importModule: async () => jsObjectModule,
				provider: chain.provider,
			}),
		).rejects.toThrow(/'js-object'.*--store sqlite.*--store file/s);
		expect(chain.calls).toEqual([]);
	});

	it('keeps refusing a js-object processor that cannot keep its state, before any RPC', async () => {
		const chain = noChain();
		await expect(
			prepareIndexing({...BASE, store: 'file', folder: './state'} as Options, {
				importModule: async () => ({createProcessor: () => ({getVersionHash: () => 'h'})}),
				provider: chain.provider,
			}),
		).rejects.toThrow(`this processor do not support "keepState" config`);
		expect(chain.calls).toEqual([]);
	});

	it('refuses a module whose tag is neither kind', async () => {
		const chain = noChain();
		await expect(
			prepareIndexing({...BASE, store: 'sqlite', db: ':memory:'} as Options, {
				importModule: async () => ({createProcessor: () => ({kind: 'sqlite', processor: {}})}),
				provider: chain.provider,
			}),
		).rejects.toThrow(/"sqlite"/);
		expect(chain.calls).toEqual([]);
	});
});
