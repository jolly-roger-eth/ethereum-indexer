import {describe, expect, it} from 'vitest';
import {bnReplacer, bnReviver, isBigIntLiteral} from '../src/utils/bigint';
import {simple_hash} from '../src/utils/hash';

// ---------------------------------------------------------------------------
// The "123n" convention: what it may claim, and what it must not touch
// ---------------------------------------------------------------------------
// This reviver runs over EVERY string in a persisted `LastSync`, and a
// `LastSync` is mostly hashes: `context.processor`, `context.config`,
// `context.processorFingerprint`. The six copies this replaces all tested the
// first and last character and then called `BigInt()` on the middle, which
// throws on an ordinary base36 digest. Inside `JSON.parse` that reads as a
// corrupt snapshot, so the state is silently discarded and re-indexed.
// ---------------------------------------------------------------------------

describe('isBigIntLiteral', () => {
	it('accepts what bnReplacer actually writes', () => {
		for (const value of [0n, 1n, -1n, 123n, 2n ** 256n]) {
			expect(isBigIntLiteral(bnReplacer('k', value))).toBe(true);
		}
	});

	it('rejects anything that is not digits followed by n', () => {
		for (const value of ['1x9tbhn', 'token', '0x1n', '1.5n', 'n', '', '12 3n', '1e3n', '--1n', 'fp-123n']) {
			expect(isBigIntLiteral(value)).toBe(false);
		}
	});

	it('rejects non-strings', () => {
		for (const value of [1, 1n, null, undefined, {}, ['1n']]) {
			expect(isBigIntLiteral(value)).toBe(false);
		}
	});
});

describe('bnReviver', () => {
	it('round-trips a BigInt through JSON', () => {
		const restored = JSON.parse(JSON.stringify({v: 42n}, bnReplacer), bnReviver);
		expect(restored.v).toBe(42n);
		expect(typeof restored.v).toBe('bigint');
	});

	it('never throws on a base36 digest, whatever shape it lands on', () => {
		// The old check accepted "starts with a digit, ends with n" and then called
		// BigInt() on the middle, which throws. One example would be luck rather than
		// a test, so this sweeps every base36 rendering, INCLUDING the shapes
		// `simple_hash` no longer produces: the guard has to stand on its own,
		// because it also runs over strings this repo did not generate.
		let sawTheDangerousShape = false;
		for (let i = 0; i < 20000; i++) {
			const digest = ((i * 2654435761) % 0xffffffff).toString(36);
			if (/^\d/.test(digest) && digest.endsWith('n')) {
				sawTheDangerousShape = true;
				expect(() => bnReviver('k', digest)).not.toThrow();
				expect(bnReviver('k', digest)).toBe(digest);
			}
		}
		// ...and the sweep really did cover the shape that used to break
		expect(sawTheDangerousShape).toBe(true);
	});

	it('leaves every simple_hash digest a string, since none can look like a BigInt', () => {
		for (let i = 0; i < 20000; i++) {
			const digest = simple_hash({payload: i});
			expect(bnReviver('k', digest)).toBe(digest);
		}
	});

	it('leaves a whole sync context untouched while reviving real BigInts beside it', () => {
		const stored = {
			context: {processor: '1x9tbhn', config: '123n', processorFingerprint: 'fp-1x9tbhn'},
			unconfirmedBlocks: [{events: [{args: {id: 7n}}]}],
		};
		const restored = JSON.parse(JSON.stringify(stored, bnReplacer), bnReviver);

		expect(restored.unconfirmedBlocks[0].events[0].args.id).toBe(7n);
		expect(restored.context.processor).toBe('1x9tbhn');
		expect(restored.context.processorFingerprint).toBe('fp-1x9tbhn');
		// `123n` IS the shape of a BigInt literal, so the convention cannot save it:
		// this is the guess the convention makes, and why processor-sqlite tags
		// instead of suffixing. The fingerprint's `fp-` prefix keeps IT out of range.
		expect(restored.context.config).toBe(123n);
	});
});
