import {describe, expect, it} from 'vitest';
import {prepareIndexing} from '../src/index.js';
import type {Options} from '../src/types.js';
import {noChain, taggedModule} from './utils/chain.js';

// ---------------------------------------------------------------------------------------------------
// A MODULE THIS COMMAND CANNOT DRIVE IS REFUSED BEFORE ANY NETWORK CALL
// ---------------------------------------------------------------------------------------------------
// There is ONE authoring path (ADR-0037), so there is no kind to check `--store`
// against any more and the mismatch refusal collapsed with it. What is left is
// the module SHAPE, and the refusal is made at the same point in the sequence
// the mismatch was made at: BEFORE the source is resolved, and therefore before
// `eth_chainId`.
//
// The provider here throws on every method, so "no network call was made" is
// checked by the test rather than asserted in prose.
// ---------------------------------------------------------------------------------------------------

const BASE = {processor: './processor.js', nodeUrl: 'http://localhost:0', store: 'sqlite', db: ':memory:'};

describe('the module shape', () => {
	it('refuses the retired KIND TAG rather than unwrapping it, naming the module', async () => {
		const chain = noChain();
		await expect(
			prepareIndexing(BASE as Options, {
				importModule: async () => taggedModule,
				provider: chain.provider,
			}),
		).rejects.toThrow(/kind.*ADR-0037.*createProcessor/s);
		expect(chain.calls).toEqual([]);
	});

	it('refuses a module with no createProcessor at all, before any RPC', async () => {
		const chain = noChain();
		await expect(
			prepareIndexing(BASE as Options, {
				importModule: async () => ({}),
				provider: chain.provider,
			}),
		).rejects.toThrow(/could not be found/);
		expect(chain.calls).toEqual([]);
	});
});
