// ---------------------------------------------------------------------------------------------------
// THE FEED CURSOR: OPAQUE, AND VALIDATED RATHER THAN TRUSTED
// ---------------------------------------------------------------------------------------------------
// The position a consumer holds between polls of `/{indexer}/feed`, encoded by
// the server into a string it hands back and takes in again.
//
// ## Why it is OPAQUE
//
// The same call ADR-0027 makes for the sync cursor, for the same reason and one
// step further out: an encoding a client can READ becomes a contract that can
// never change, because somebody will parse it and then a purely internal change
// breaks them. The sync cursor is an opaque string behind the storage seam; this
// one is an opaque string across an HTTP boundary, where the audience is not even
// ours (a consumer is built OUTSIDE etherfold, ADR-0005).
//
// **What the encoding IS and is NOT.** It is a checksummed, scrambled, base64url
// framing of a small JSON envelope: deterministic, self-checking, and readable by
// exactly one thing, the decoder below. It is NOT encryption and NOT a signature:
// there is no key here, so a determined client that reimplements this file can
// read a cursor, and one that hand-crafts a payload can mint one. Neither is a
// threat this needs to stop. What it stops is the failure that actually happens:
// ACCIDENTAL dependence on the format -- a client that base64-decodes the string,
// finds a number, and starts incrementing it -- which is exactly the "derive the
// next position by adding one" bug that `seq` HOLES make silently wrong.
//
// The checksum is what makes an edited cursor a REFUSAL rather than a plausible
// answer: without it, flipping a character would decode to some other position
// and be served.
//
// ## What it CARRIES, and why none of it routes
//
// The VIEW, the INDEXER NAME, the STREAM and the POSITION. The route already
// routed -- `/{indexer}/feed` says which indexer, and the handler says which view
// -- so the first three are never read to decide WHERE to look. They are copies
// kept so that a MISMATCH is refused:
//
//  - a cursor minted at one indexer and presented at another is refused, because
//    two named indexers may share a byte-identical stream and a position in one
//    means nothing in the other;
//  - a cursor whose STREAM is no longer the one served is refused, because a
//    `seq` in one stream is unrelated to the same number in another, and serving
//    across them is a plausible wrong answer rather than an obvious failure;
//  - a cursor minted for the OTHER view is refused, because the two views count
//    in different spaces (`seq` here, `(blockNumber, logIndex)` there).
//
// This is the read-side twin of `WireContextMismatchError`, which carries
// `{source, config}` in the ADR-0004 envelope even though the endpoint already
// identifies the receiver.
//
// ## One codec, several views
//
// `at` is the VIEW's own position and this codec does not interpret it, so the
// canonical view adds its block hash by putting one in there rather than by
// minting a second encoding. Two encoders would be two refusal paths that drift.
//
// Distinct from `../cursor.ts`, which is the SYNC cursor's `/status` report: that
// one is a value the server never parses at all, reported verbatim from a host's
// reporter. This one the server both writes and reads, and no one else does.
// ---------------------------------------------------------------------------------------------------

/** Bumped if the envelope's shape ever changes; an older `v` decodes to nothing. */
const CURSOR_VERSION = 1;

/** A fixed constant, and deliberately not a secret: see the header. */
const SCRAMBLE_SEED = 0x9e37_79b9;

/** WHICH view a cursor addresses: the `seq`-ordered, retraction-aware feed. */
export const STREAM_FEED_VIEW = 'stream';

/**
 * WHICH view a cursor addresses: the CANONICAL view, live entries only, ordered
 * by `(blockNumber, logIndex)` under the caller's gate.
 *
 * Its `at` carries the position, the block HASH it is validated against, and
 * the stream MARK the fork block is searched from -- all three inside the same
 * envelope this file writes, which is what "one codec" means in practice.
 */
export const CANONICAL_FEED_VIEW = 'canonical';

/**
 * A view's own position, which this codec carries and never interprets.
 *
 * The `seq` feed puts `{seq}` in it; the canonical view puts its block
 * coordinates and the hash it validates.
 */
export type FeedCursorPosition = Readonly<Record<string, number | string>>;

/** What a cursor carries, once the server has opened it. */
export type FeedCursorEnvelope = {
	/** WHICH view minted it. Validated, never used to select a view. */
	readonly view: string;
	/** WHICH named indexer minted it. Validated, never used to route. */
	readonly indexer: string;
	/** WHICH stream it is a position in. Validated, never used to select a stream. */
	readonly stream: string;
	/** The position itself, in the minting view's own terms. */
	readonly at: FeedCursorPosition;
};

/** Encode one envelope into the string a consumer holds. */
export function encodeFeedCursor(envelope: FeedCursorEnvelope): string {
	const payload = new TextEncoder().encode(
		JSON.stringify({v: CURSOR_VERSION, w: envelope.view, i: envelope.indexer, s: envelope.stream, a: envelope.at}),
	);
	const checksum = fnv1a32(payload);
	const scrambled = xorWithKeystream(payload, checksum);
	const framed = new Uint8Array(4 + scrambled.length);
	framed[0] = (checksum >>> 24) & 0xff;
	framed[1] = (checksum >>> 16) & 0xff;
	framed[2] = (checksum >>> 8) & 0xff;
	framed[3] = checksum & 0xff;
	framed.set(scrambled, 4);
	return base64urlEncode(framed);
}

/**
 * Open a cursor, or answer `undefined` for anything that is not one this server
 * wrote.
 *
 * Every way it can fail collapses to the same answer on purpose. A cursor that
 * was truncated, edited, minted by an older build or invented is equally "not a
 * position I can honour", and telling those apart would tell a client something
 * about the encoding, which is the one thing this must not do.
 */
export function decodeFeedCursor(cursor: string): FeedCursorEnvelope | undefined {
	const framed = base64urlDecode(cursor);
	if (!framed || framed.length < 5) return undefined;

	const checksum =
		(((framed[0] as number) << 24) |
			((framed[1] as number) << 16) |
			((framed[2] as number) << 8) |
			(framed[3] as number)) >>>
		0;
	const payload = xorWithKeystream(framed.subarray(4), checksum);
	if (fnv1a32(payload) !== checksum) return undefined;

	let decoded: unknown;
	try {
		decoded = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(payload));
	} catch {
		return undefined;
	}
	if (typeof decoded !== 'object' || decoded === null) return undefined;

	const {v, w, i, s, a} = decoded as {v?: unknown; w?: unknown; i?: unknown; s?: unknown; a?: unknown};
	if (v !== CURSOR_VERSION) return undefined;
	if (typeof w !== 'string' || typeof i !== 'string' || typeof s !== 'string') return undefined;
	if (typeof a !== 'object' || a === null || Array.isArray(a)) return undefined;
	for (const value of Object.values(a as Record<string, unknown>)) {
		if (typeof value !== 'number' && typeof value !== 'string') return undefined;
	}

	return {view: w, indexer: i, stream: s, at: a as FeedCursorPosition};
}

/**
 * WHY a presented cursor was refused.
 *
 * Four kinds and not one, because a consumer's recovery differs: an `unreadable`
 * cursor is a client bug, a `foreign-indexer` one was minted somewhere else, a
 * `foreign-view` one belongs to the other view, and a `foreign-stream` one is the
 * case that is nobody's fault and needs an answer to act on.
 */
export type FeedCursorRefusal = {kind: 'unreadable' | 'foreign-indexer' | 'foreign-view' | 'foreign-stream'};

/**
 * Open a cursor and check its three copies against what is actually being served.
 *
 * The order is the order of how WRONG each is: an unreadable cursor is not a
 * position at all; a foreign indexer's cursor never belonged here; a foreign
 * view's counts in another space; and only then is the stream question asked,
 * which is the one a consumer answers by re-subscribing rather than by fixing a
 * bug.
 */
export function openFeedCursor(
	cursor: string,
	served: {view: string; indexer: string; stream: string},
): {ok: true; envelope: FeedCursorEnvelope} | {ok: false; refusal: FeedCursorRefusal} {
	const envelope = decodeFeedCursor(cursor);
	if (!envelope) return {ok: false, refusal: {kind: 'unreadable'}};
	if (envelope.indexer !== served.indexer) return {ok: false, refusal: {kind: 'foreign-indexer'}};
	if (envelope.view !== served.view) return {ok: false, refusal: {kind: 'foreign-view'}};
	if (envelope.stream !== served.stream) return {ok: false, refusal: {kind: 'foreign-stream'}};
	return {ok: true, envelope};
}

// ---------------------------------------------------------------------------------------------------
// The framing. Hand-rolled because this package names no runtime (a test asserts
// it), so there is no `node:crypto` and no `Buffer` here; `btoa` is avoided too,
// because it is a latin1 bridge and this is bytes.
// ---------------------------------------------------------------------------------------------------

/** FNV-1a over the payload: a checksum, not a MAC, and it does not pretend to be. */
function fnv1a32(bytes: Uint8Array): number {
	let hash = 0x811c_9dc5;
	for (const byte of bytes) {
		hash ^= byte;
		hash = Math.imul(hash, 0x0100_0193) >>> 0;
	}
	return hash >>> 0;
}

/**
 * Scramble (and unscramble: it is its own inverse) against a keystream seeded
 * from the payload's own checksum.
 *
 * Seeded per payload rather than from the constant alone, so two cursors do not
 * share a keystream and the JSON's fixed prefix is not a crib sitting in the same
 * place in every one of them.
 */
function xorWithKeystream(bytes: Uint8Array, seed: number): Uint8Array {
	let state = (seed ^ SCRAMBLE_SEED) >>> 0 || 1;
	const out = new Uint8Array(bytes.length);
	for (let i = 0; i < bytes.length; i++) {
		// xorshift32: deterministic, allocation-free, and enough to make the output
		// unreadable to anything that is not this function
		state ^= (state << 13) >>> 0;
		state >>>= 0;
		state ^= state >>> 17;
		state ^= (state << 5) >>> 0;
		state >>>= 0;
		out[i] = (bytes[i] as number) ^ (state & 0xff);
	}
	return out;
}

/** URL-safe and unpadded, so a cursor survives a query string untouched. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function base64urlEncode(bytes: Uint8Array): string {
	let out = '';
	for (let i = 0; i < bytes.length; i += 3) {
		const b0 = bytes[i] as number;
		const b1 = i + 1 < bytes.length ? (bytes[i + 1] as number) : undefined;
		const b2 = i + 2 < bytes.length ? (bytes[i + 2] as number) : undefined;
		out += ALPHABET[b0 >> 2];
		out += ALPHABET[((b0 & 0b11) << 4) | ((b1 ?? 0) >> 4)];
		if (b1 === undefined) break;
		out += ALPHABET[((b1 & 0b1111) << 2) | ((b2 ?? 0) >> 6)];
		if (b2 === undefined) break;
		out += ALPHABET[b2 & 0b11_1111];
	}
	return out;
}

function base64urlDecode(text: string): Uint8Array | undefined {
	if (text.length === 0) return undefined;
	const sextets: number[] = [];
	for (const character of text) {
		const value = ALPHABET.indexOf(character);
		if (value < 0) return undefined;
		sextets.push(value);
	}
	const bytes: number[] = [];
	for (let i = 0; i < sextets.length; i += 4) {
		const s0 = sextets[i] as number;
		const s1 = sextets[i + 1];
		// a lone sextet is six bits with nothing to join: not something this encoder
		// can have produced
		if (s1 === undefined) return undefined;
		bytes.push(((s0 << 2) | (s1 >> 4)) & 0xff);
		const s2 = sextets[i + 2];
		if (s2 === undefined) break;
		bytes.push(((s1 << 4) | (s2 >> 2)) & 0xff);
		const s3 = sextets[i + 3];
		if (s3 === undefined) break;
		bytes.push(((s2 << 6) | s3) & 0xff);
	}
	return new Uint8Array(bytes);
}
