/**
 * ## Addressing state by block: hash, height, or time
 *
 * The store keeps exactly ONE addressing mechanism. All three axes resolve to a
 * block number through the canonical block table, and the reads then run the one
 * as-of predicate (`AS_OF_PREDICATE`) on the version range columns. There is no
 * second predicate and no second table.
 *
 * ### Hash is the identifier a consumer should store
 *
 * A consumer that records "I acted on the state at 18,000,123" has pinned a
 * height, and a reorg silently changes what that height refers to: the read
 * still succeeds, and quietly answers about a different chain. A consumer that
 * records the block HASH gets, after that same reorg, "no such block", which is
 * itself the signal that whatever it recorded is now invalid. The asymmetry
 * between a silently wrong answer and a loud absent one is the whole argument,
 * and it is why `revertTo` deletes block rows rather than rewriting them.
 *
 * That is also why an unresolvable address is not folded into `undefined` on the
 * read path: see `NoSuchBlockError`.
 *
 * ### Rows exist only for blocks that carry our logs
 *
 * The block table is not a copy of the chain's headers. State only changes at
 * blocks where our events occur, so the latest recorded block at or before T
 * holds exactly the state the true block at T held, and a consumer only ever
 * pins a hash it saw on a log we delivered. Storing every header would be tens
 * of millions of rows for no additional answer.
 *
 * The consequence, and it is deliberate: a HEIGHT needs no row (heights are what
 * the version ranges are keyed on, so any height is readable), while a HASH must
 * have one (an unrecorded hash is indistinguishable from a reorged-out one, and
 * both mean "not a block this store can answer about").
 */

/** A block as recorded in the canonical block table. */
export type RecordedBlock = {
	number: number;
	hash: string;
	/** Seconds since the epoch, as the chain reports it. */
	timestamp: number;
};

/**
 * Where to read state as of: a height, a block hash, or a wall-clock time.
 *
 * A bare number is shorthand for `{number}`, which keeps the height axis the
 * ergonomic one to type while leaving hash the one to persist (see the module
 * documentation above for why those are different things).
 */
export type BlockAddress = number | {number: number} | {hash: string} | {timestamp: number};

/** Which axis an address was written on, after parsing. */
export type ParsedBlockAddress =
	| {axis: 'height'; number: number}
	| {axis: 'hash'; hash: string}
	| {axis: 'timestamp'; timestamp: number};

/** Why an address did not resolve to a recorded block. */
export type NoSuchBlockReason =
	/** The hash is not a block this store recorded: it was never indexed, or it has been reorged out. */
	| 'unknown-hash'
	/** No recorded block is at or before that time: it predates everything indexed here. */
	| 'no-recorded-block-at-or-before';

/**
 * Thrown by a read whose address does not resolve to a block.
 *
 * This is deliberately NOT `undefined`. The reads answer `undefined` for "that
 * block is known and the entity was absent from it", which is an ordinary
 * answer a caller acts on normally. "There is no such block" is the opposite
 * kind of news: the caller's pinned block is not part of this chain's history
 * any more, so nothing derived from it is valid. Returning `undefined` for both
 * would let a consumer treat a reorged-out pin as an empty result and carry on,
 * which is precisely the silent failure hash-addressing exists to prevent.
 *
 * The soft form, for callers that want to branch rather than catch, is
 * `resolveBlockNumber`, which answers `undefined` and throws nothing.
 */
export class NoSuchBlockError extends Error {
	readonly name = 'NoSuchBlockError';

	constructor(
		readonly address: BlockAddress,
		readonly reason: NoSuchBlockReason,
	) {
		super(
			reason === 'unknown-hash'
				? `no such block: ${JSON.stringify(address)} is not a block this store recorded. ` +
						`It was never indexed, or it has been reorged out, so any state pinned to it is no longer valid.`
				: `no such block: no recorded block is at or before ${JSON.stringify(address)}. ` +
						`It predates the first block indexed here.`,
		);
	}
}

/**
 * Read the address, on exactly one axis.
 *
 * A shape that names no axis (or names one we do not have) is a caller error and
 * is thrown, never guessed at: silently defaulting `{height: 101}` to some other
 * axis would answer a question nobody asked.
 */
export function parseBlockAddress(address: BlockAddress): ParsedBlockAddress {
	if (typeof address === 'number') {
		return {axis: 'height', number: assertHeight(address, address)};
	}
	if (address && typeof address === 'object') {
		const keys = Object.keys(address);
		if (keys.length === 1) {
			if ('number' in address) return {axis: 'height', number: assertHeight(address.number, address)};
			if ('hash' in address) return {axis: 'hash', hash: normalizeBlockHash(address.hash)};
			if ('timestamp' in address) {
				return {axis: 'timestamp', timestamp: normalizeBlockTimestamp((address as {timestamp: number}).timestamp)};
			}
		}
	}
	throw new Error(
		`invalid block address: ${JSON.stringify(address)}. ` +
			`Expected a block number, or exactly one of {number}, {hash}, {timestamp}.`,
	);
}

function assertHeight(value: unknown, address: BlockAddress): number {
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
		throw new Error(`invalid block address: ${JSON.stringify(address)}. A height must be a non-negative integer.`);
	}
	return value;
}

/**
 * Fold a block hash to one canonical spelling: lower case.
 *
 * Hex case carries no meaning in a block hash (unlike an EIP-55 address), but
 * SQL string comparison is case-sensitive, so a hash that has travelled through
 * a consumer's storage and come back upper-cased would fail to resolve. That
 * failure would read as "reorged out", which is the one answer this store must
 * never give wrongly. Folding on write and on lookup removes the possibility.
 */
export function normalizeBlockHash(hash: unknown): string {
	if (typeof hash !== 'string' || hash.length === 0) {
		throw new Error(`invalid block hash: ${JSON.stringify(hash)}. Expected a non-empty string.`);
	}
	return hash.toLowerCase();
}

/**
 * Read `blockTimestamp` off a log into seconds since the epoch.
 *
 * The timestamp comes from the log itself (`blockTimestamp`, standardised in
 * `execution-apis#639`, served by current clients), so addressing by time needs
 * no extra block-by-number round-trip. It arrives inconsistently encoded: the
 * spec says a QUANTITY is 0x-prefixed hex, and at least one client returned it
 * in decimal.
 *
 * The prefix is the ONLY signal, and the ambiguity is not recoverable without
 * it: `'1705366720'` is a valid hex string as well as a valid decimal one, and
 * the two readings are ~2,300 years apart. So `0x` means hex, bare digits mean
 * decimal, and anything else throws rather than defaulting to 0 (a timestamp of
 * 0 would sort before every block and quietly poison time addressing).
 *
 * This lives at the store's seam because the store's `BlockPointer.timestamp` is
 * where the numeric contract is defined. The ingestion side (the stream-builder,
 * not yet built) calls it once, when it turns a log into a `BlockPointer`,
 * rather than re-deriving the same rule.
 */
export function normalizeBlockTimestamp(value: string | number | bigint): number {
	const seconds = toSeconds(value);
	if (!Number.isInteger(seconds) || seconds < 0 || !Number.isSafeInteger(seconds)) {
		throw new Error(
			`invalid block timestamp: ${JSON.stringify(String(value))}. Expected seconds since the epoch as a ` +
				`non-negative integer, a 0x-prefixed hex quantity, or a decimal string.`,
		);
	}
	return seconds;
}

const HEX_QUANTITY = /^0[xX][0-9a-fA-F]+$/;
const DECIMAL_QUANTITY = /^[0-9]+$/;

function toSeconds(value: string | number | bigint): number {
	if (typeof value === 'number') return value;
	if (typeof value === 'bigint') return Number(value);
	if (typeof value === 'string') {
		const text = value.trim();
		if (HEX_QUANTITY.test(text)) return parseInt(text, 16);
		if (DECIMAL_QUANTITY.test(text)) return Number(text);
		return Number.NaN;
	}
	return Number.NaN;
}
