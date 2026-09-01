/**
 * ## One BigInt convention, and why it is a TAG rather than a suffix
 *
 * `JSON.stringify` throws outright on a BigInt, and a decoded log's `args` hold
 * one for every `uint256` the ABI declares, so anything in this repo that
 * persists or ships a `LastSync` needs a convention. There is exactly one, and
 * it is here: a BigInt goes out as `{__bigint__: "123"}` and comes back from
 * that shape and no other.
 *
 * ### What it replaced, and why the replacement was not optional
 *
 * Every storage adapter used to suffix a BigInt's decimal form with `n` and
 * revive anything that read that way. That convention is IRREDUCIBLY AMBIGUOUS:
 * `"123n"` is what `123n` serializes to AND a perfectly legal string for a
 * contract to emit, so the decoder could not tell them apart and silently
 * changed the type of whichever it got wrong. It was silent in both directions
 * -- a real BigInt read back as a string breaks arithmetic downstream, a string
 * read back as a BigInt breaks comparisons (including `===` against a hash) and
 * JSON round-trips -- and a persisted `LastSync` genuinely carries both kinds at
 * once, since `unconfirmedBlocks` holds real decoded events while `context`
 * holds digests.
 *
 * Two containment fixes came before this and neither could reach the guess
 * itself: `535ccc1` stopped the six copies of the decoder THROWING on values
 * that were never numbers (an ordinary base36 `simple_hash` digest such as
 * `1x9tbhn` threw from inside `JSON.parse`, so the CLI read a good snapshot as
 * corrupt), and gave `simple_hash` a leading `h` so its digests can no longer
 * land on the ambiguous shape. Both narrowed the blast radius. Only the tag
 * removes the guess.
 *
 * ### The legacy form is not read
 *
 * A `"123n"` string is now just a string, everywhere, forever. Translating it
 * would be the same guess under a new name, so it is not translated; and it is
 * not refused value-by-value either, because refusing every string of digits
 * ending in `n` would refuse legitimate event data. Where a persisted artifact
 * carries a FORMAT number the number was bumped instead, so a file written under
 * the old convention is refused AS A FILE by its own reader rather than
 * half-decoded here: `STREAM_FIXTURE_FORMAT` (`stream/fixture.ts`) and the
 * blob snapshot's `BLOB_SNAPSHOT_FORMAT` (`snapshot.ts`, the number the CLI's
 * keeper writes) both went to 2.
 *
 * The one place `"123n"` still appears is INSIDE `simple_hash`, which renders a
 * BigInt that way purely to have bytes to hash. Nothing ever decodes that, so
 * there is no guess to make; see the note there for why the digest keeps its
 * prefix regardless.
 */

/**
 * The single reserved key. An object with this key and nothing else is a BigInt;
 * anything else, including an object that merely CONTAINS the key, is data.
 */
const BIGINT_TAG = '__bigint__';

/**
 * `JSON.stringify` replacer: BigInt out as `{__bigint__: "123"}`.
 *
 * Reads the RAW value off `this` rather than trusting the `value` argument,
 * which `JSON.stringify` has already passed through any `toJSON` on the way in.
 * Without that, a BigInt reached through a `toJSON` (some libraries install one
 * on `BigInt.prototype`) is invisible here and the stringify throws instead.
 */
export function taggedBnReplacer(this: unknown, key: string, value: any): any {
	const raw = (this as Record<string, unknown>)?.[key];
	if (typeof raw === 'bigint') return {[BIGINT_TAG]: raw.toString()};
	return value;
}

/** `JSON.parse` reviver: `{__bigint__: "123"}` back to a BigInt, and nothing else touched. */
export function taggedBnReviver(key: string, value: any): any {
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		const keys = Object.keys(value);
		if (keys.length === 1 && keys[0] === BIGINT_TAG) {
			const text = (value as Record<string, unknown>)[BIGINT_TAG];
			if (typeof text === 'string') return BigInt(text);
		}
	}
	return value;
}
