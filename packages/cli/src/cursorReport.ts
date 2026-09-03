import {parseStoredCursor, SYNC_CURSOR_KEY, type StateStore} from '@etherfold/processor-entities';

/**
 * What a command that OWNS a store tells `/status` about where its pipeline has
 * got to.
 *
 * ## Why this is a summary and not the cursor
 *
 * The **sync cursor** is an opaque string behind the storage seam (ADR-0027),
 * and what that string holds is a serialized `LastSync` carrying
 * `unconfirmedBlocks`: whole blocks of DECODED events, every `uint256` of them a
 * `bigint`. The server reports whatever a reporter hands it VERBATIM -- it does
 * not parse it, so it cannot bound it afterwards either (ADR-0047) -- so handing
 * the cursor over whole would put an unbounded blob of event data on the one
 * page an operator refreshes while something is wrong, and would fail
 * `JSON.stringify` on the first `uint256` it met.
 *
 * So the four numbers below, and nothing else. They are chosen to answer the two
 * questions a status page is asked: **is it moving** (`lastToBlock` across two
 * reads) and **how far behind is it** (`latestBlock - lastToBlock`).
 * `unconfirmedBlocks` is a COUNT rather than the window itself, for the reason
 * above -- the window is the blob.
 *
 * What is deliberately NOT here: the `context` hashes (an identity, not a
 * progress report; a reader comparing them wants the wire, not `/status`) and
 * anything the store computes on demand, since a reporter runs on every
 * `/status` and must stay one cursor read.
 */
export type StoreCursorReport = {
	/** The first block of the last range that was applied. */
	lastFromBlock: number;
	/** How far the fold has got: the number that ADVANCES while a run makes progress. */
	lastToBlock: number;
	/** The chain tip observed when that range was applied, so a reader can see the lag. */
	latestBlock: number;
	/** How many blocks are still reorg-eligible. A COUNT: the window itself is the blob. */
	unconfirmedBlocks: number;
};

/**
 * Read the store's cursor and summarise it, or report nothing.
 *
 * `undefined` is the honest answer before the first block lands: there is no
 * cursor yet, and `/status` says so with a reason rather than inventing a zero
 * that reads like "synced to block 0". An unparseable cursor answers the same
 * way, because `parseStoredCursor` treats one as never-synced -- which is what
 * the fold itself does with it.
 */
export async function readCursorReport(store: StateStore): Promise<StoreCursorReport | undefined> {
	const lastSync = parseStoredCursor(await store.readCursor(SYNC_CURSOR_KEY));
	if (!lastSync) return undefined;
	return {
		lastFromBlock: lastSync.lastFromBlock,
		lastToBlock: lastSync.lastToBlock,
		latestBlock: lastSync.latestBlock,
		unconfirmedBlocks: lastSync.unconfirmedBlocks.length,
	};
}
