import {describe, expect, it} from 'vitest';
import type {Abi} from 'abitype';
import {EthereumIndexer} from '../src/indexer.js';
import type {EventProcessor, IndexingSource} from '../src/types.js';

// Minimal provider: empty chain, no logs.
function makeProvider() {
	return {
		async request(args: {method: string; params?: any}): Promise<any> {
			switch (args.method) {
				case 'eth_chainId':
					return '0x1';
				case 'eth_blockNumber':
					return '0x0';
				case 'eth_getLogs':
					return [];
				default:
					throw new Error(`unexpected method ${args.method}`);
			}
		},
	} as any;
}

const SOURCE: IndexingSource<Abi> = {
	chainId: '1',
	contracts: [{abi: [] as unknown as Abi, address: '0x0000000000000000000000000000000000000001', startBlock: 0}],
};

type Hooks = {clearGate?: Promise<void>; resetGate?: Promise<void>};

function makeProcessor(versionHash: string, hooks: Hooks = {}): EventProcessor<Abi, void> {
	return {
		getVersionHash: () => versionHash,
		// required on `EventProcessor`: a fake that omits it is a fake that would
		// lose drift detection without anybody noticing
		getCodeFingerprint: () => undefined,
		load: async () => undefined,
		process: async () => undefined,
		reset: async () => {
			if (hooks.resetGate) await hooks.resetGate;
		},
		clear: async () => {
			if (hooks.clearGate) await hooks.clearGate;
		},
	} as any;
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => (resolve = r));
	return {promise, resolve};
}

describe('EthereumIndexer.updateProcessor (core #5: align with updateIndexer)', () => {
	it('blocks the index action while a (version-changing) updateProcessor is in flight (like updateIndexer)', async () => {
		// gate the OLD processor's clear() — that is what updateProcessor awaits before calling load(),
		// so during this window load() has NOT started yet and the only thing that should prevent a
		// racing indexMore is disableProcessing()/block().
		const gate = deferred();
		const original = makeProcessor('v1', {clearGate: gate.promise});
		const indexer = new EthereumIndexer<Abi, void>(makeProvider(), original, SOURCE);
		await indexer.load();

		const updating = indexer.updateProcessor(makeProcessor('v2'));
		await Promise.resolve();

		// While reconfiguring, processing must be disabled so a racing indexMore cannot run
		// against the half-swapped indexer. updateIndexer guarantees this via disableProcessing();
		// updateProcessor must do the same.
		expect(() => indexer.indexMore()).toThrow('Blocked');

		gate.resolve();
		await updating;
	});

	it('re-enables processing after a version-changing updateProcessor resolves', async () => {
		const indexer = new EthereumIndexer<Abi, void>(makeProvider(), makeProcessor('v1'), SOURCE);
		await indexer.load();

		await indexer.updateProcessor(makeProcessor('v2'));

		// after the swap settles, indexMore must work again (processing re-enabled)
		await expect(indexer.indexMore()).resolves.toBeTruthy();
	});

	it('does not swap this.processor before deciding (no-op path must not replace the instance mid-flight)', async () => {
		const original = makeProcessor('v1');
		const indexer = new EthereumIndexer<Abi, void>(makeProvider(), original, SOURCE);
		await indexer.load();

		// A same-version-hash update is a no-op: there is nothing to reset/reload, so the running
		// processor instance should not be silently replaced (which would swap mid-flight before
		// the version check even decided anything needed to happen).
		const sameVersion = makeProcessor('v1');
		await indexer.updateProcessor(sameVersion);

		expect((indexer as any).processor).toBe(original);
	});

	it('swaps a same-version processor when force:true is passed', async () => {
		const original = makeProcessor('v1');
		const indexer = new EthereumIndexer<Abi, void>(makeProvider(), original, SOURCE);
		await indexer.load();

		// Same version hash, but the caller explicitly forces the swap (e.g. they know the new
		// instance differs and forgot / chose not to bump the version hash).
		const sameVersionForced = makeProcessor('v1');
		await indexer.updateProcessor(sameVersionForced, {force: true});

		expect((indexer as any).processor).toBe(sameVersionForced);
	});

	it('force:true clears the old processor and reloads even when the version is unchanged', async () => {
		let cleared = false;
		const original = makeProcessor('v1');
		(original as any).clear = async () => {
			cleared = true;
		};
		const indexer = new EthereumIndexer<Abi, void>(makeProvider(), original, SOURCE);
		await indexer.load();

		await indexer.updateProcessor(makeProcessor('v1'), {force: true});

		expect(cleared).toBe(true);
	});
});

/**
 * What a reconfigure REPORTS, which is the half a caller holding a copy of the
 * state has to act on.
 *
 * The three verbs all end in one of two very different places -- the state
 * survives, or it is gone and being recomputed -- and used to say nothing about
 * which. `@etherfold/browser` needs the answer to re-seed the store it
 * publishes; anything else with its own copy needs it for the same reason. It is
 * REPORTED rather than inferred because the alternative is every caller
 * re-deriving this rule (the version hash, `force`, and the source hashes), and
 * a caller that derives it wrong fails silently.
 */
describe('EthereumIndexer reconfigure outcomes', () => {
	it('reports a discard when the processor version changed', async () => {
		const indexer = new EthereumIndexer<Abi, void>(makeProvider(), makeProcessor('v1'), SOURCE);
		await indexer.load();

		expect(await indexer.updateProcessor(makeProcessor('v2'))).toEqual({stateDiscarded: true});
	});

	it('reports NO discard when the version hash did not move, because the swap was skipped', async () => {
		const indexer = new EthereumIndexer<Abi, void>(makeProvider(), makeProcessor('v1'), SOURCE);
		await indexer.load();

		// the "author edited a handler and forgot to bump `version`" case: the core
		// cannot see the edit, so it keeps the running processor
		expect(await indexer.updateProcessor(makeProcessor('v1'))).toEqual({stateDiscarded: false});
	});

	it('reports a discard when force is passed against an unchanged version', async () => {
		const indexer = new EthereumIndexer<Abi, void>(makeProvider(), makeProcessor('v1'), SOURCE);
		await indexer.load();

		expect(await indexer.updateProcessor(makeProcessor('v1'), {force: true})).toEqual({stateDiscarded: true});
	});

	it('reports a discard when the source changed, and none when it hashes the same', async () => {
		const indexer = new EthereumIndexer<Abi, void>(makeProvider(), makeProcessor('v1'), SOURCE);
		await indexer.load();

		// a DIFFERENT object carrying the same contents: the hash is over the
		// contents, so this is indistinguishable from no change at all
		const same: IndexingSource<Abi> = {
			chainId: '1',
			contracts: [{abi: [] as unknown as Abi, address: '0x0000000000000000000000000000000000000001', startBlock: 0}],
		};
		expect(await indexer.updateIndexer({source: same})).toEqual({stateDiscarded: false});

		// a second contract: a different source, so the stored state cannot stand
		const changed: IndexingSource<Abi> = {
			chainId: '1',
			contracts: [
				{abi: [] as unknown as Abi, address: '0x0000000000000000000000000000000000000001', startBlock: 0},
				{abi: [] as unknown as Abi, address: '0x0000000000000000000000000000000000000002', startBlock: 0},
			],
		};
		expect(await indexer.updateIndexer({source: changed})).toEqual({stateDiscarded: true});
	});

	it('always reports a discard from reset, because reset IS the discard', async () => {
		const indexer = new EthereumIndexer<Abi, void>(makeProvider(), makeProcessor('v1'), SOURCE);
		await indexer.load();

		expect(await indexer.reset()).toEqual({stateDiscarded: true});
	});
});
