import {describe, expect, it, vi} from 'vitest';
import type {Abi} from 'abitype';
import {EthereumIndexer} from '../src/indexer';
import {simple_hash} from '../src/utils/hash';
import type {ContextIdentifier, EventProcessor, IndexingSource, LastSync, ProcessorDriftReport} from '../src/types';

// ---------------------------------------------------------------------------
// PROCESSOR DRIFT: the declared version says "unchanged", the code says otherwise
// ---------------------------------------------------------------------------
// `getVersionHash()` is author-declared, so an author who edits a handler and
// forgets to bump `version` gets state computed by the PREVIOUS logic, adopted
// silently and served forever. Under docs/adr/0008 it is worse: a version change
// is what triggers the blue-green rebuild, so a missed bump means the rebuild
// never runs.
//
// The fingerprint is the second opinion. It is compared HERE, in the core,
// rather than in each `EventProcessor` implementation, because drift is defined
// relative to the core's own adopt-or-discard decision ("version hash equal but
// code different"), and re-deriving that decision inside each implementation
// would duplicate the branch that `processor-sqlite/src/sync.ts` already had to
// reason about once.
// ---------------------------------------------------------------------------

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

/** A context the core will ACCEPT (source and stream config match the defaults). */
function storedContext(processorHash: string, processorFingerprint?: string): ContextIdentifier {
	return {
		source: [{startBlock: 0, hash: simple_hash(SOURCE)}],
		config: simple_hash({finality: 17}),
		processor: processorHash,
		...(processorFingerprint === undefined ? {} : {processorFingerprint}),
	};
}

function storedLastSync(context: ContextIdentifier): LastSync<Abi> {
	return {context, latestBlock: 100, lastFromBlock: 0, lastToBlock: 100, unconfirmedBlocks: []};
}

/** A processor that hands back a persisted cursor, as a keeper-backed one would. */
function makeProcessor(
	versionHash: string,
	options: {stored?: ContextIdentifier; fingerprint?: string} = {},
): EventProcessor<Abi, void> & {cleared: boolean} {
	const processor = {
		cleared: false,
		getVersionHash: () => versionHash,
		getCodeFingerprint: () => options.fingerprint,
		load: async () => (options.stored ? {state: undefined, lastSync: storedLastSync(options.stored)} : undefined),
		process: async () => undefined,
		reset: async () => {},
		clear: async () => {
			processor.cleared = true;
		},
	} as any;
	return processor;
}

function indexerWith(processor: EventProcessor<Abi, void>, config: {strictProcessorDrift?: boolean} = {}) {
	const reports: ProcessorDriftReport[] = [];
	const indexer = new EthereumIndexer<Abi, void>(makeProvider(), processor, SOURCE, config);
	indexer.onProcessorDrift = (report) => reports.push(report);
	return {indexer, reports};
}

describe('processor drift detection', () => {
	it('reports when the version hash is unchanged but the handler code is not', async () => {
		const processor = makeProcessor('v1', {stored: storedContext('v1', 'fingerprint-A'), fingerprint: 'fingerprint-B'});
		const {indexer, reports} = indexerWith(processor);

		await indexer.load();

		expect(reports).toHaveLength(1);
		expect(reports[0].storedFingerprint).toBe('fingerprint-A');
		expect(reports[0].currentFingerprint).toBe('fingerprint-B');
		// the report NAMES which processor drifted, by the version hash both sides agree on
		expect(reports[0].processorHash).toBe('v1');
		expect(reports[0].message).toContain('v1');
	});

	it('does not halt on drift by default: the state is still adopted', async () => {
		// The false positive is real (a re-minification changes handler source without
		// changing behaviour), so the default cannot be a refusal to start.
		const processor = makeProcessor('v1', {stored: storedContext('v1', 'fingerprint-A'), fingerprint: 'fingerprint-B'});
		const {indexer, reports} = indexerWith(processor);

		const lastSync = await indexer.load();

		expect(reports).toHaveLength(1);
		expect(lastSync.lastToBlock).toBe(100);
		expect(processor.cleared).toBe(false);
	});

	it('refuses to start under strictProcessorDrift', async () => {
		const processor = makeProcessor('v1', {stored: storedContext('v1', 'fingerprint-A'), fingerprint: 'fingerprint-B'});
		const {indexer, reports} = indexerWith(processor, {strictProcessorDrift: true});

		await expect(indexer.load()).rejects.toThrow(/PROCESSOR DRIFT/);
		// ...and the host still learns WHY: the report goes out before the throw
		expect(reports).toHaveLength(1);
	});

	it('says nothing when the fingerprint matches', async () => {
		const processor = makeProcessor('v1', {stored: storedContext('v1', 'fingerprint-A'), fingerprint: 'fingerprint-A'});
		const {indexer, reports} = indexerWith(processor);

		await indexer.load();

		expect(reports).toEqual([]);
	});

	it('says nothing when the version WAS bumped, code change or not', async () => {
		// A deliberate bump is never a drift. The state is discarded on the version
		// hash, which is the mechanism this whole check exists to back up, not
		// replace.
		const processor = makeProcessor('v2', {stored: storedContext('v1', 'fingerprint-A'), fingerprint: 'fingerprint-B'});
		const {indexer, reports} = indexerWith(processor);

		await indexer.load();

		expect(reports).toEqual([]);
		expect(processor.cleared).toBe(true);
	});

	it('says nothing for a cursor persisted BEFORE fingerprints existed', async () => {
		// Absence means "unknown", never "drifted". Otherwise every existing
		// deployment reports drift exactly once on upgrade, and a report that cried
		// wolf on day one is a report nobody reads on day two.
		const legacy = storedContext('v1');
		expect('processorFingerprint' in legacy).toBe(false);
		const processor = makeProcessor('v1', {stored: legacy, fingerprint: 'fingerprint-B'});
		const {indexer, reports} = indexerWith(processor);

		await indexer.load();

		expect(reports).toEqual([]);
	});

	it('says nothing when the processor cannot fingerprint itself', async () => {
		// `getCodeFingerprint` is REQUIRED on `EventProcessor`, but it may ANSWER
		// `undefined`: a processor whose handlers are all bound or proxied has no
		// readable source. "Cannot tell" is not "changed", so nothing is reported.
		const processor = makeProcessor('v1', {stored: storedContext('v1', 'fingerprint-A')});
		const {indexer, reports} = indexerWith(processor);

		await indexer.load();

		expect(reports).toEqual([]);
	});

	it('says nothing when there is no persisted state to be stale', async () => {
		const processor = makeProcessor('v1', {fingerprint: 'fingerprint-B'});
		const {indexer, reports} = indexerWith(processor);

		await indexer.load();

		expect(reports).toEqual([]);
	});

	it('reports again on the NEXT boot, rather than going quiet after being seen once', async () => {
		// The stored fingerprint describes the code that computed the state, so it is
		// not refreshed when the drift is reported: the condition lasts until the
		// author bumps `version`, and so does the report.
		const stored = storedContext('v1', 'fingerprint-A');
		const first = indexerWith(makeProcessor('v1', {stored, fingerprint: 'fingerprint-B'}));
		await first.indexer.load();
		const second = indexerWith(makeProcessor('v1', {stored, fingerprint: 'fingerprint-B'}));
		await second.indexer.load();

		expect(first.reports).toHaveLength(1);
		expect(second.reports).toHaveLength(1);
	});

	it('records the CURRENT fingerprint on a fresh cursor, so the next boot can compare', async () => {
		const processor = makeProcessor('v1', {fingerprint: 'fingerprint-B'});
		const {indexer} = indexerWith(processor);

		const lastSync = await indexer.load();

		expect(lastSync.context.processorFingerprint).toBe('fingerprint-B');
	});

	it('survives a listener that throws, because a drift report must not break loading', async () => {
		const processor = makeProcessor('v1', {stored: storedContext('v1', 'fingerprint-A'), fingerprint: 'fingerprint-B'});
		const indexer = new EthereumIndexer<Abi, void>(makeProvider(), processor, SOURCE);
		indexer.onProcessorDrift = () => {
			throw new Error('listener blew up');
		};

		await expect(indexer.load()).resolves.toBeTruthy();
	});

	it('is never silent: it logs at ERROR even with no listener set', async () => {
		// A callback nobody sets would be a silent detector; a log nobody can route
		// would be hard to alert on. It does both, and the log level is `error`
		// because "the state you are serving was computed by code that no longer
		// exists" is not an info.
		const {logs} = await import('named-logs');
		const namedLogger = logs('@etherfold/core');
		const spy = vi.spyOn(namedLogger, 'error').mockImplementation(() => {});
		try {
			const processor = makeProcessor('v1', {
				stored: storedContext('v1', 'fingerprint-A'),
				fingerprint: 'fingerprint-B',
			});
			const indexer = new EthereumIndexer<Abi, void>(makeProvider(), processor, SOURCE);

			await indexer.load();

			expect(spy).toHaveBeenCalledWith(expect.stringContaining('PROCESSOR DRIFT'));
		} finally {
			spy.mockRestore();
		}
	});
});
