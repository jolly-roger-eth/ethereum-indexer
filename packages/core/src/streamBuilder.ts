import type {Abi} from 'abitype';
import {logs} from 'named-logs';
import {InvalidBatchError, WireContextMismatchError} from './errors.js';
import {
	assertAscendingByBlock,
	defaultFromBlockOf,
	generateStreamToAppend,
	getFromBlock,
	stateMatches,
	resolveStreamConfig,
	sameWireContext,
	wireContextOf,
	type ReorgDetection,
} from './internal/engine/utils.js';
import type {ReorgRecorder} from './reorgCounters.js';
import type {
	EventProcessor,
	IndexingSource,
	LastSync,
	ProvidedIndexerConfig,
	UntypedWireBatch,
	UsedStreamConfig,
	WireBatch,
	WireContext,
} from './types.js';
import {taggedBnReplacer, taggedBnReviver} from './utils/bigint.js';

const namedLogger = logs('@etherfold/core');

/**
 * What one accepted batch did, in the terms a HOST can act on.
 *
 * `expectedFromBlock` is where the NEXT one must start, handed back so an
 * acknowledged sender needs no second round-trip to ask.
 */
export type IngestionOutcome = {
	/** Events handed to the processor as canonical. */
	applied: number;
	/** Events handed to the processor as retractions, derived here and by nobody else. */
	retracted: number;
	/** Where the next batch must start. */
	expectedFromBlock: number;
	/**
	 * Present only when this batch concluded a reorg; `cause` says HOW it was
	 * concluded.
	 *
	 * REPORTED, never delegated. A caller reads it to log, to answer a sender or
	 * to decide what to do next; it is NOT how the revert gets counted, and a
	 * caller that counted from it would count only on the shape it happens to be.
	 * The count is taken once, inside `receive`, through the injected
	 * `ReorgRecorder` (ADR-0050).
	 */
	reorg?: ReorgDetection;
};

/** The outcome plus the cursor itself, which only an ABI-aware caller can read. */
export type IngestionResult<ABI extends Abi> = IngestionOutcome & {lastSync: LastSync<ABI>};

/**
 * The receiving side of the wire, as everything above it needs to see it.
 *
 * A host (an HTTP route, a queue consumer, a test) needs exactly three things
 * from the stream-builder: the identity it indexes, where the next batch must
 * start, and a way to hand one over. Typing that as an INTERFACE rather than as
 * the class is what keeps `@etherfold/server` free of an ABI type parameter: the
 * server never inspects a log, so it has no business being generic over the ABI
 * of the processor it hosts.
 */
export type LogIngestion = {
	readonly context: WireContext;
	expectedFromBlock(): Promise<number>;
	receive(batch: UntypedWireBatch): Promise<IngestionOutcome>;
};

/**
 * What a receiver is built with: the stream configuration half of the wire
 * identity, plus the one collaborator a receiver has that is not the processor.
 *
 * `stream` is HASHED into `context` and `recordReorg` deliberately is not: where
 * a count is written down is a deployment's business, and a receiver that hashed
 * it would refuse every batch from a sender configured identically but wired to
 * a different database.
 */
export type StreamBuilderOptions<ABI extends Abi> = Pick<ProvidedIndexerConfig<ABI>, 'stream'> & {
	/**
	 * Where a concluded reorg is counted, supplied by whoever owns the store
	 * (ADR-0050). Absent on a host with nowhere to write, and then nothing is
	 * counted and nothing else changes.
	 */
	recordReorg?: ReorgRecorder;
};

/**
 * The STREAM-BUILDER of ADR-0003, and the receiving half of the wire contract of
 * ADR-0004.
 *
 * It takes contiguous ranges of raw logs from a stateless log-fetcher, derives
 * every retraction itself, drives an `EventProcessor`, and is authoritative
 * about where the next range must start. It makes NO chain calls, which is the
 * whole reason it is a separate object from `IndexerGeneration`: that class opens
 * `load()` with `eth_chainId`, so the half of a split deployment that hosts the
 * processor cannot use it (recorded in
 * `work/notes/observations/indexer-load-needs-a-chain-so-the-server-half-cannot-call-it.md`).
 *
 * ## Why the cursor is read on every call and never cached
 *
 * The intended host is serverless: several isolates may serve the same database,
 * and an instance can be created and destroyed between two batches. An
 * in-memory cursor would be one instance's private opinion of a value the
 * DATABASE owns, and two instances would disagree the moment either of them
 * moved it. So `expectedFromBlock()` and `receive()` both read the persisted
 * cursor through `processor.load()` first. That costs a read per batch and buys
 * the property the design is built on: the cursor a sender is told is the cursor
 * the state actually has.
 *
 * ## The three identities, and who checks which
 *
 * - `source` and `config` are asserted by the SENDER, on every batch, and
 *   checked here against what this receiver indexes (`WireContextMismatchError`).
 * - `processor` cannot be asserted by the sender at all, so it is checked
 *   against the PERSISTED cursor instead: a cursor written by another processor
 *   version, or for another source, is state that means something else, and it
 *   is discarded (`processor.clear()`) rather than resumed on top of. That is
 *   the hole `docs/reviews/todo-triage.md` found in every persistence layer.
 *
 * ## What it deliberately does not do
 *
 * It does not batch a large stream into several `process()` calls the way
 * `IndexerGeneration.feed` does. A batch is one HTTP request and the sender chose
 * its size; splitting it here would add a second place where a partially-applied
 * range is possible, and the processor already applies block by block
 * atomically. It also does not store the emission stream: that arrives with
 * ADR-0006, in the `indexer-server-feed` spec, and belongs to this same
 * component when it does.
 */
export class StreamBuilder<ABI extends Abi, ProcessResultType = unknown> implements LogIngestion {
	/** The earliest block this source can have anything to say about. */
	readonly defaultFromBlock: number;
	/** The resolved stream config, which is what `config` in the context hashes. */
	readonly streamConfig: UsedStreamConfig;
	/** The `{source, config}` a sender must assert to be talking to this receiver. */
	readonly context: WireContext;

	private readonly finality: number;
	private readonly recordReorg: ReorgRecorder | undefined;

	constructor(
		private readonly processor: EventProcessor<ABI, ProcessResultType>,
		private readonly source: IndexingSource<ABI>,
		config: StreamBuilderOptions<ABI> = {},
	) {
		this.recordReorg = config.recordReorg;
		// The defaults MUST match `IndexerGeneration`'s and the sending `LogFetcher`'s,
		// because the hash of the resolved config is half the wire identity: a
		// receiver that defaulted `finality` differently would refuse every batch a
		// fetcher sent, naming a config hash neither side can see. Hence the one
		// shared resolver rather than three copies of the same object literal.
		this.streamConfig = resolveStreamConfig(config.stream);
		this.finality = this.streamConfig.finality;
		this.defaultFromBlock = defaultFromBlockOf(source);
		this.context = wireContextOf(source, this.streamConfig);
	}

	/**
	 * Where the next batch must start.
	 *
	 * It is NOT `lastToBlock + 1`: it reaches back to `latestBlock - finality` so
	 * the unconfirmed window is re-delivered every round, which is the only way a
	 * reorg is ever detected. A sender that computed this itself would be holding
	 * the state that makes it stateless.
	 *
	 * **Reading this can WRITE**, in one case: a persisted cursor belonging to
	 * another source, config or processor version is cleared here rather than
	 * merely ignored (see `currentLastSync`). That is deliberate. The alternative
	 * is answering with a number derived from state this server is about to wipe,
	 * so the read and the following write would disagree. Nothing is lost that was
	 * not already invalid, and the same reconciliation happens on `load()` in the
	 * single-process shape.
	 */
	async expectedFromBlock(): Promise<number> {
		return getFromBlock(await this.currentLastSync(), this.defaultFromBlock, this.finality);
	}

	/**
	 * Apply one batch, or refuse it having applied nothing.
	 *
	 * The order of the three refusals is deliberate. Identity first, because a
	 * batch for another source must never be told to resume from a block number
	 * that means nothing to it. Then the envelope, which is cheap and local. Then
	 * the cursor, which is `generateStreamToAppend`'s own check and therefore the
	 * engine's, not a second one that could disagree with it.
	 */
	async receive(batch: WireBatch<ABI>): Promise<IngestionResult<ABI>> {
		this.assertContext(batch.context);
		assertWellFormed(batch);

		const lastSync = await this.currentLastSync();
		const {eventStream, newLastSync, reorg} = generateStreamToAppend(lastSync, this.defaultFromBlock, batch.logs, {
			newLatestBlock: batch.latestBlock,
			newLastFromBlock: batch.fromBlock,
			newLastToBlock: batch.toBlock,
			finality: this.finality,
		});

		await this.processor.process(eventStream, newLastSync);

		if (reorg) {
			// ONCE per concluded revert, and HERE rather than in whatever called us. A
			// combined process folds through `createDirectIngestion` and an HTTP one
			// through a route; putting the count at either entrance leaves the other
			// shape blind, and putting it at both double-counts the shape that does both.
			// This is the one place every shape passes through exactly once (ADR-0050).
			await this.noteReorg(reorg);
		}

		return {
			applied: eventStream.filter((event) => !event.removed).length,
			retracted: eventStream.filter((event) => event.removed).length,
			lastSync: newLastSync,
			expectedFromBlock: getFromBlock(newLastSync, this.defaultFromBlock, this.finality),
			reorg,
		};
	}

	// -- internals -----------------------------------------------------------

	/**
	 * Say what was reverted, and count it if this deployment gave us somewhere to.
	 *
	 * AFTER the batch was applied, and best-effort by design: the state and the
	 * cursor already moved atomically inside the processor, so a failure here loses
	 * a count rather than a block. An operational counter that could roll back the
	 * state it describes -- or fail the request that earned it, telling a sender to
	 * re-send a batch which was in fact applied -- would be a far worse trade. That
	 * guarantee used to belong to the ingest route (`recordReorgSafely`); it is
	 * here now, so every deployment shape has it.
	 *
	 * The log line is here for the same reason the count is: an absence-driven
	 * revert is the one an operator must see, and a combined process has no route
	 * to log it from.
	 */
	private async noteReorg(reorg: ReorgDetection): Promise<void> {
		if (reorg.cause === 'absence') {
			namedLogger.error(
				`reverted state from an ABSENCE at block ${reorg.blockNumber} (${reorg.blockHash}) for ` +
					`${JSON.stringify(this.context)}. Absence is an inference, not proof: it is indistinguishable from a ` +
					`sender that under-delivered the range. A rising rate of these means truncation or misconfiguration.`,
				reorg,
			);
		} else {
			namedLogger.info(`reverted state from a hash contradiction at block ${reorg.blockNumber}`, reorg);
		}
		if (!this.recordReorg) return;
		try {
			await this.recordReorg(reorg);
		} catch (err) {
			namedLogger.error(`could not record the reorg counter: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private assertContext(received: WireContext | undefined): void {
		if (!sameWireContext(this.context, received)) {
			throw new WireContextMismatchError(this.context, received as WireContext);
		}
	}

	/**
	 * The persisted cursor if it is ours, a fresh one otherwise.
	 *
	 * "Otherwise" is doing real work: a cursor whose context does not match is not
	 * ignored, it is CLEARED, because the state it points at was computed by a
	 * different processor or for a different source and would otherwise be indexed
	 * on top of. This mirrors `IndexerGeneration.promiseToLoad`'s discard branch,
	 * minus the chain calls that branch is wrapped in.
	 */
	private async currentLastSync(): Promise<LastSync<ABI>> {
		const processorHash = this.processor.getVersionHash();
		const loaded = await this.processor.load(this.source, this.streamConfig);
		if (loaded) {
			const {lastSync} = loaded;
			if (
				processorHash === lastSync.context.processor &&
				stateMatches(this.context.source, this.context.config, lastSync.lastToBlock, lastSync.context)
			) {
				return lastSync;
			}
			namedLogger.info(`STATE DISCARDED AS PROCESSOR CHANGED`, {
				context: this.context,
				storedContext: lastSync.context,
				processorHash,
			});
			await this.processor.clear();
		}
		return {
			context: {
				source: this.context.source,
				config: this.context.config,
				processor: processorHash,
				processorFingerprint: this.processor.getCodeFingerprint(),
			},
			lastToBlock: 0,
			lastFromBlock: 0,
			latestBlock: 0,
			unconfirmedBlocks: [],
		};
	}
}

function isBlockNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * The envelope checks, which are the ones a receiver can make before it knows
 * anything about its own cursor.
 *
 * Separate from `StreamBuilder` because they are a fact about the BATCH and not
 * about this receiver, so a sender-side test and a host that wants to reject
 * early can both reach for them.
 */
export function assertWellFormed<ABI extends Abi>(batch: WireBatch<ABI>): void {
	if (!isBlockNumber(batch.fromBlock) || !isBlockNumber(batch.toBlock) || !isBlockNumber(batch.latestBlock)) {
		throw new InvalidBatchError(
			`a batch's fromBlock, toBlock and latestBlock must be whole non-negative numbers, got ` +
				`{fromBlock: ${batch.fromBlock}, toBlock: ${batch.toBlock}, latestBlock: ${batch.latestBlock}}`,
		);
	}
	if (batch.toBlock < batch.fromBlock) {
		throw new InvalidBatchError(
			`a batch is a contiguous range, but toBlock (${batch.toBlock}) is below fromBlock (${batch.fromBlock})`,
		);
	}
	if (batch.toBlock > batch.latestBlock) {
		throw new InvalidBatchError(
			`a batch cannot cover blocks above the chain tip it reports: toBlock (${batch.toBlock}) > latestBlock (${batch.latestBlock})`,
		);
	}
	if (!Array.isArray(batch.logs)) {
		throw new InvalidBatchError(`a batch must carry a logs array, got ${typeof batch.logs}`);
	}
	assertAscendingByBlock(batch.logs, 'a batch');
	for (const log of batch.logs) {
		if (!isBlockNumber(log?.blockNumber) || log.blockNumber < batch.fromBlock || log.blockNumber > batch.toBlock) {
			throw new InvalidBatchError(
				`a log at block ${log?.blockNumber} is outside the range [${batch.fromBlock}, ${batch.toBlock}] the batch ` +
					`claims to cover. A payload holds every log in its range and nothing else; a truncated fetch is ` +
					`expressed by lowering toBlock.`,
			);
		}
		if (log.removed) {
			throw new InvalidBatchError(
				`a log at block ${log.blockNumber} is marked removed. No reorg information crosses the wire: the ` +
					`receiver derives every retraction, so a sender that ships them holds reorg logic it must not have.`,
			);
		}
	}
}

/**
 * A batch as JSON, with BigInts tagged.
 *
 * The codec is here, next to the envelope, so that both halves of the wire use
 * the same one: a decoded log's `args` hold a BigInt for every `uint256` an ABI
 * declares, `JSON.stringify` throws outright on those, and the `"123n"` suffix
 * convention would revive a contract-emitted string ending in `n` as a number.
 * See `taggedBnReplacer`.
 */
export function serializeWireBatch<ABI extends Abi>(batch: WireBatch<ABI>): string {
	return JSON.stringify(batch, taggedBnReplacer);
}

/** The inverse of `serializeWireBatch`. Shape is NOT validated here; see `assertWellFormed`. */
export function parseWireBatch<ABI extends Abi>(text: string): WireBatch<ABI> {
	return JSON.parse(text, taggedBnReviver) as WireBatch<ABI>;
}
