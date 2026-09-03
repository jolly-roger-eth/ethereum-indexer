/**
 * Turn an object into a key-sorted array form, so that two objects differing
 * only in key ORDER hash alike.
 *
 * `undefined` values are dropped, and NOTHING else is. That distinction is the
 * whole of this function's care: dropping `undefined` matches what
 * `JSON.stringify` does anyway, so a value hashed before being persisted and the
 * same value hashed after a JSON round-trip agree. Dropping the other falsy
 * values, which this used to do with a bare `if (value)`, made `{fee: 0}` hash
 * identically to `{}` and `{enabled: false}` identically to `{}`. Those are
 * different configurations, and a processor configured with one while its state
 * was computed under the other would have the state adopted as current: the same
 * silent lie the `unknown` version fallback used to tell, one layer down.
 */
function normalizeAsArray(obj: object): any {
	if (obj === null) {
		return null;
	}
	if (Array.isArray(obj)) {
		return obj.map((v) => normalizeAsArray(v));
	} else if (typeof obj === 'object') {
		const arr = [];
		const keys = Object.keys(obj).sort();
		for (const key of keys) {
			const value = (obj as any)[key];
			if (value !== undefined) {
				arr.push([key, normalizeAsArray(value)]);
			}
		}
		return arr;
	} else {
		return obj;
	}
}

/**
 * The BYTES a digest of this value is taken over: key-sorted, whitespace-free,
 * `undefined` dropped, BigInts stringified with an `n` suffix.
 *
 * Extracted from `simple_hash` rather than copied, because a second
 * canonicalisation is a second answer to "are these two values the same": the
 * stream digest (`stream/identity.ts`) takes a WIDE hash over these same bytes,
 * and two normalisations that disagreed anywhere would make one digest move
 * where the other did not. A string passes through untouched, which is what
 * makes hashing an already-canonical value idempotent.
 *
 * Note what changing this would cost: every digest ever computed, and digests
 * are persisted.
 */
export function canonical_form(obj: any): string {
	return typeof obj === 'string'
		? obj
		: JSON.stringify(normalizeAsArray(obj as object), (_, value) =>
				typeof value === 'bigint' ? `${value}n` : value,
			).replace(/\s+/g, '');
}

/**
 * A short, stable, order-insensitive digest of any JSON-ish value.
 *
 * BigInt values are stringified with an `n` suffix on the way in, because
 * `JSON.stringify` throws on them outright and a processor config holding a
 * `uint256` is ordinary. That is the ONE surviving use of the `"123n"` form in
 * this repo and it is not the convention that was removed: these bytes exist to
 * be hashed and are never parsed back, so there is nothing here to guess at.
 * (Note that changing it would change every digest ever computed, and digests
 * are persisted.)
 *
 * Note the size: 32 bits, rendered base36. It is a change DETECTOR, not a
 * cryptographic commitment, and it is compared against exactly one other value
 * at a time.
 *
 * The leading `h` is not decoration, and it is kept even though what it guarded
 * against is gone. A digest is persisted inside `LastSync` (as
 * `context.processor`, `context.config`, `context.source[].hash`), and the
 * storage adapters used to revive BigInts from the `"123n"` string convention.
 * A bare base36 digest of all digits ending in `n` (`8918n`) IS that shape, so
 * it came back from storage as a BigInt rather than a string, and
 * `processorHash === context.processor` then compared a string to a BigInt and
 * discarded good state. No guard in the reviver could fix that one, because at
 * that point the two were genuinely indistinguishable; only the digest could, by
 * never having the shape. The adapters now tag their BigInts (`utils/bigint.ts`)
 * so no digest is at risk whatever it looks like, but the prefix stays: dropping
 * it would change every digest, and the shape is still ambiguous to any reader
 * outside this repo that kept the old convention.
 */
export function simple_hash(obj: any): string {
	const str = canonical_form(obj);
	let hash = 0;
	for (let i = 0; i < str.length; i++) {
		const char = str.charCodeAt(i);
		hash = (hash << 5) - hash + char;
		hash &= hash; // Convert to 32bit integer
	}
	return `h${new Uint32Array([hash])[0].toString(36)}`;
}
