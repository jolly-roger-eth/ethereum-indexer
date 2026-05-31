import {describe, expect, it} from 'vitest';
import type {Abi} from 'abitype';
import {EthereumIndexer} from '../src/indexer';
import type {EventProcessor, IndexingSource} from '../src/types';

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
