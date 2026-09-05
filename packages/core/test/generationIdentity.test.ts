import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {GENERATION_DIGEST_LENGTH, generationDigestOf} from '../src/generation/identity.js';
import {resolveStreamConfig} from '../src/internal/engine/utils.js';
import {streamDigestOf} from '../src/stream/identity.js';
import type {IndexingSource} from '../src/types.js';

// ---------------------------------------------------------------------------
// A GENERATION AS ONE OPAQUE VALUE
// ---------------------------------------------------------------------------
// `GenerationId` is `{stream, processor}` and the registry keeps it as two
// fields because it KEYS on them. This is the same identity rendered as ONE
// value, for the other job an identity has: being REPORTED outward to somebody
// who compares it against the last one they saw (`@etherfold/server` advertises
// it on every feed response).
//
// Two properties, and they pull in opposite directions, which is why both are
// asserted here:
//
//  - it MOVES when either half does, or a consumer is told nothing changed at
//    the moment everything did;
//  - it is STABLE otherwise, or a consumer comparing it pauses on nothing.
//
// And it is OPAQUE: a digest rather than the two parts, so that WHAT a
// generation is composed of can change without a consumer noticing. That is not
// a hiding measure -- the rule is written in the source -- it stops ACCIDENTAL
// dependence, which is the failure that actually happens.
// ---------------------------------------------------------------------------

const A = '0x0000000000000000000000000000000000000001' as const;

const transfer = {
	type: 'event',
	name: 'Transfer',
	anonymous: false,
	inputs: [
		{indexed: true, name: 'from', type: 'address'},
		{indexed: true, name: 'to', type: 'address'},
		{indexed: false, name: 'id', type: 'uint256'},
	],
} as const;

const SOURCE: IndexingSource<[typeof transfer]> = {
	chainId: '1',
	contracts: [{abi: [transfer], address: A, startBlock: 100}],
};

const STREAM = streamDigestOf(SOURCE, resolveStreamConfig({finality: 12}));
const OTHER_STREAM = streamDigestOf(SOURCE, resolveStreamConfig({finality: 24}));

describe('a generation digest moves with EITHER half, and with nothing else', () => {
	it('is stable for one stream and one fold', () => {
		expect(generationDigestOf({stream: STREAM, processor: '1.0.0-abc'})).toBe(
			generationDigestOf({stream: STREAM, processor: '1.0.0-abc'}),
		);
	});

	it('moves when the FOLD changes over one stream, which no cursor check can see', () => {
		expect(generationDigestOf({stream: STREAM, processor: '2.0.0-abc'})).not.toBe(
			generationDigestOf({stream: STREAM, processor: '1.0.0-abc'}),
		);
	});

	it('moves when the STREAM changes under one fold', () => {
		// without this half, an indexer that re-subscribed onto another stream would
		// be told its generation was unchanged
		expect(generationDigestOf({stream: OTHER_STREAM, processor: '1.0.0-abc'})).not.toBe(
			generationDigestOf({stream: STREAM, processor: '1.0.0-abc'}),
		);
	});

	it('cannot have one half mistaken for the other', () => {
		// the halves are hashed as named fields rather than concatenated, so
		// `{stream: "ab", processor: "c"}` and `{stream: "a", processor: "bc"}` are
		// two generations and not one
		expect(generationDigestOf({stream: 'ab', processor: 'c'})).not.toBe(
			generationDigestOf({stream: 'a', processor: 'bc'}),
		);
	});
});

describe('it is OPAQUE, and rendered like the digest it is built on', () => {
	it('is 128 bits of fixed-length lowercase hex', () => {
		expect(GENERATION_DIGEST_LENGTH).toBe(32);
		const digest = generationDigestOf({stream: STREAM, processor: '1.0.0-abc'});
		expect(digest).toMatch(/^[0-9a-f]{32}$/);
		expect(digest).toHaveLength(GENERATION_DIGEST_LENGTH);
	});

	it('hands back neither of its parts, so nothing can read one out of it', () => {
		const digest = generationDigestOf({stream: STREAM, processor: '1.0.0-abc'});

		expect(digest).not.toBe(STREAM);
		expect(digest).not.toContain(STREAM);
		expect(digest).not.toContain('1.0.0');
	});

	it('is synchronous, with no second implementation and no 32-bit detector', () => {
		const source = readFileSync(new URL('../src/generation/identity.ts', import.meta.url), 'utf-8');
		const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

		expect(code).toContain(`from 'viem'`);
		expect(code).toMatch(/\bsha256\b/);
		// the same discipline the stream digest keeps, for the same reasons: no
		// `crypto.subtle` (asynchronous, secure-context) and no native fast path
		// beside a pure-JS fallback
		expect(code).not.toMatch(/crypto|subtle|await|async|Promise/);
		// and not the 32-bit change DETECTOR: a collision here is a fold change a
		// consumer is never told about
		expect(code).not.toMatch(/simple_hash\(/);
	});
});
