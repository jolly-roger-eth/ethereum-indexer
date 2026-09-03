import type {Abi} from 'abitype';
import type {LastSync} from '../types.js';

/**
 * WHAT a caller wants to know about one transaction.
 *
 * `minedAtBlock` is OPTIONAL and is the height the caller's own node reports for
 * the transaction (from a receipt). It is not needed for the answer that matters
 * and it is not trusted as an identity: it only widens what can be concluded
 * about a transaction that has already fallen out of the indexer's unconfirmed
 * window. See `checkTxInclusion` for why the receipt's BLOCK HASH is deliberately
 * not taken here.
 */
export type TxInclusionQuery = {
	txHash: string;
	minedAtBlock?: number;
};

/**
 * Whether the state derived so far already accounts for a transaction.
 *
 * Three values and not two, because "I cannot tell" is a real answer here and
 * collapsing it into either of the others is what produces a wrong UI:
 * `'included'` wrongly means a double-counted optimistic update, `'absent'`
 * wrongly means an effect that briefly disappears.
 */
export type TxInclusionStatus = 'included' | 'absent' | 'unknown';

/**
 * HOW the verdict was reached, so a caller can log or display the difference
 * between a proof and a fallback.
 *
 * - `window-hit`: the transaction's own events are in the indexer's unconfirmed
 *   window AND the cursor has passed them. This is the load-bearing one, and the
 *   only one that is independent of any chain view but the indexer's own.
 * - `window-miss`: the window covers the region and does not hold it.
 * - `ahead-of-cursor`: the indexer has not processed that far yet.
 * - `below-window`: past finality, concluded from heights (see the caveat in
 *   `checkTxInclusion`).
 * - `window-not-covering`: the indexer is far enough behind the chain tip that
 *   its window says nothing about the region asked about.
 * - `not-synced`: nothing has been indexed yet.
 */
export type TxInclusionBasis =
	| 'window-hit'
	| 'window-miss'
	| 'ahead-of-cursor'
	| 'below-window'
	| 'window-not-covering'
	| 'not-synced';

export type TxInclusionVerdict = {
	status: TxInclusionStatus;
	basis: TxInclusionBasis;
	/** Where the indexer processed it, present only on `window-hit`. */
	blockNumber?: number;
	/** The hash of that block IN THE INDEXER'S view, which may differ from the caller's node. */
	blockHash?: string;
};

/**
 * Does the indexed state already account for these transactions?
 *
 * The question an app has to answer before it applies an optimistic update on
 * top of indexed state: if the state already contains the transaction's effects
 * and the app adds its own prediction on top, a non-idempotent update (a
 * counter, a balance, an append) is counted twice.
 *
 * ## Why the caller's receipt cannot answer it
 *
 * The obvious approach is to compare the receipt's block against how far the
 * indexer has got. It does not work, and neither half of it works:
 *
 * - A HEIGHT is a local opinion about a chain, not an identity. The app's wallet
 *   node and the indexer's node are different nodes; "block 100" is not a shared
 *   name for a block.
 * - The receipt's BLOCK HASH is an identity, but it is the wrong one: after a
 *   reorg the same transaction can be re-included in a different block, so the
 *   app can hold a receipt saying `h1` while the indexer legitimately processed
 *   the transaction in `h2`. Comparing hashes then reports "not indexed" for a
 *   transaction that IS indexed, which is precisely the double-count.
 *
 * So the question is about the indexer's own chain and only the indexer can
 * answer it. What makes that cheap here is that it already holds the answer:
 * `LastSync.unconfirmedBlocks` keeps the reorg-eligible window as whole blocks
 * WITH their events, and every event carries its `transactionHash`. Nothing is
 * stored for this, no processor declares anything for it, and the set maintains
 * itself: a reorged-out block leaves the window, so a retracted transaction stops
 * being reported as included and starts again if it is re-included.
 *
 * ## A hit must also be BEHIND the cursor
 *
 * Being in the window is not the same as having been applied. `feed` builds the
 * new window up front and then walks `lastToBlock` forward batch by batch, so a
 * transaction can be in the published window several batches before the
 * processor has seen its events. A hit above `lastToBlock` is therefore reported
 * `absent`/`ahead-of-cursor` rather than `included`.
 *
 * ## What it cannot tell you
 *
 * - **Only transactions that emitted events this indexer indexes can hit.** The
 *   window is sparse (`generateStreamToAppend` keeps a block only when it carries
 *   events), so a transaction that emitted nothing indexed is indistinguishable
 *   from one never seen. For the case this exists to serve that is not a
 *   restriction: an app optimistically updates because it expects the events its
 *   processor handles.
 * - **`absent` means "not in the window", so the caller must not ask about a
 *   transaction older than the window.** A transaction the app itself just
 *   submitted cannot be, which is the intended use. Pass `minedAtBlock` to close
 *   even that gap.
 * - **`below-window` rests on the finality assumption**, and on no other: below
 *   `latestBlock - finality` the two nodes are assumed to agree on the chain, so
 *   heights are comparable again. That is the same assumption the indexer already
 *   makes when it prunes a block out of its window, not a new one.
 *
 * @param lastSync the cursor the state was computed at. Read it from the SAME
 * snapshot as the state you are reconciling: a cursor read separately can be
 * ahead of the rows it is compared against.
 * @param queries the transactions to ask about, which is the app's own pending
 * set and therefore small
 * @param finality the finality depth the indexer is configured with
 * (`IndexerGeneration.finalityDepth`), which is what bounds the window
 * @returns one verdict per query, keyed by the `txHash` string as given
 */
export function checkTxInclusion<ABI extends Abi>(
	lastSync: LastSync<ABI> | undefined,
	queries: readonly TxInclusionQuery[],
	finality: number,
): Record<string, TxInclusionVerdict> {
	const verdicts: Record<string, TxInclusionVerdict> = {};

	if (!lastSync) {
		for (const query of queries) {
			verdicts[query.txHash] = {status: 'unknown', basis: 'not-synced'};
		}
		return verdicts;
	}

	const {lastToBlock, latestBlock} = lastSync;
	// The oldest block the window is GUARANTEED to cover. Measured from the chain
	// tip and not from the cursor, because that is the test
	// `generateStreamToAppend` applies when it decides whether a block enters the
	// window at all: a block is kept when `latestBlock - block.number <= finality`.
	// Measuring from `lastToBlock` would claim coverage of blocks that were
	// processed while the indexer was still catching up and never entered it.
	const windowFloor = latestBlock - finality;

	const processed = indexWindow(lastSync);

	for (const query of queries) {
		verdicts[query.txHash] = verdictFor(query, processed, lastToBlock, windowFloor);
	}
	return verdicts;
}

function verdictFor(
	query: TxInclusionQuery,
	processed: Map<string, {blockNumber: number; blockHash: string}>,
	lastToBlock: number,
	windowFloor: number,
): TxInclusionVerdict {
	const hit = processed.get(query.txHash.toLowerCase());
	if (hit) {
		if (hit.blockNumber > lastToBlock) {
			// known, but not applied yet: the feed loop publishes the whole window
			// before it walks the cursor through it
			return {status: 'absent', basis: 'ahead-of-cursor'};
		}
		return {status: 'included', basis: 'window-hit', blockNumber: hit.blockNumber, blockHash: hit.blockHash};
	}

	if (query.minedAtBlock !== undefined) {
		if (query.minedAtBlock > lastToBlock) {
			return {status: 'absent', basis: 'ahead-of-cursor'};
		}
		if (query.minedAtBlock < windowFloor) {
			// deep enough that the caller's node and the indexer's node are assumed to
			// agree, and the cursor is past it, so it has been processed -- whether or
			// not it left anything behind in this indexer's state
			return {status: 'included', basis: 'below-window'};
		}
	}

	if (lastToBlock < windowFloor) {
		// catching up: the window describes the tip, the cursor is nowhere near it,
		// and nothing in between is known either way
		return {status: 'unknown', basis: 'window-not-covering'};
	}

	return {status: 'absent', basis: 'window-miss'};
}

/**
 * The transactions the unconfirmed window holds, keyed by lowercased hash.
 *
 * Built once per call rather than scanned per query, because the window is
 * bounded by the finality depth while the caller's pending set is a handful.
 */
function indexWindow<ABI extends Abi>(lastSync: LastSync<ABI>): Map<string, {blockNumber: number; blockHash: string}> {
	const processed = new Map<string, {blockNumber: number; blockHash: string}>();
	for (const block of lastSync.unconfirmedBlocks) {
		for (const event of block.events) {
			// A window block holds the events that were APPLIED, so a retraction marker
			// should never be here. Skipped rather than trusted: reporting a retracted
			// transaction as included is the one mistake this function must not make.
			if (event.removed) {
				continue;
			}
			processed.set(event.transactionHash.toLowerCase(), {blockNumber: block.number, blockHash: block.hash});
		}
	}
	return processed;
}
