/**
 * The numeric and textual contract of `BlockPointer`, normalised once.
 *
 * Both of these live here rather than in any one backend because they define
 * what the SHARED type means. A hash that resolves in one store and not in
 * another, or a timestamp read as hex by one and as decimal by another, would be
 * a difference between backends in the one place the seam promises there is
 * none.
 */

/**
 * Fold a block hash to one canonical spelling: lower case.
 *
 * Hex case carries no meaning in a block hash (unlike an EIP-55 address), but
 * string comparison is case-sensitive in every store we target, so a hash that
 * has travelled through a consumer's storage and come back upper-cased would
 * fail to resolve. That failure would read as "reorged out", which is the one
 * answer a store must never give wrongly. Folding on write and on lookup removes
 * the possibility.
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
 * This lives at the seam because `BlockPointer.timestamp` is where the numeric
 * contract is defined. The ingestion side calls it once, when it turns a log
 * into a `BlockPointer`, rather than re-deriving the same rule.
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
