import {describe, expect, it} from 'vitest';
import {bnReplacer, bnReviver} from '../src/utils/bn.js';

// ---------------------------------------------------------------------------
// The snapshot's BigInt convention, and the strings it must keep its hands off
// ---------------------------------------------------------------------------
// `bnReviver` runs over EVERY string in a snapshot, including the sync context's
// hashes. It used to accept anything that started with a digit and ended in `n`
// and then call `BigInt()` on the middle unguarded, so an ordinary base36 hash
// such as `1x9tbhn` threw a SyntaxError from inside `JSON.parse`. The CLI reads
// that as a corrupt snapshot and cold starts, blaming the file, every run.
// ---------------------------------------------------------------------------

describe('bnReviver', () => {
	it('revives an actual BigInt literal', () => {
		expect(bnReviver('k', '123n')).toBe(123n);
		expect(bnReviver('k', '-123n')).toBe(-123n);
		expect(bnReviver('k', '0n')).toBe(0n);
	});

	it('does not throw on a hash that merely looks like one', () => {
		expect(() => bnReviver('k', '1x9tbhn')).not.toThrow();
		expect(bnReviver('k', '1x9tbhn')).toBe('1x9tbhn');
	});

	it('leaves every other string alone, including ones ending in n', () => {
		for (const value of ['token', '0x1n', '1.5n', 'n', '', '12 3n', 'nnn']) {
			expect(bnReviver('k', value)).toBe(value);
		}
	});

	it('round-trips a snapshot holding both BigInts and hash-shaped strings', () => {
		// The pairing that matters: `unconfirmedBlocks` carries real BigInt args
		// while `context` carries hashes, in the same document.
		const snapshot = {
			context: {processor: '1x9tbhn', config: '123n-ish', processorFingerprint: 'fp-1x9tbhn'},
			amount: 42n,
		};
		const restored = JSON.parse(JSON.stringify(snapshot, bnReplacer), bnReviver);

		expect(restored.amount).toBe(42n);
		expect(restored.context.processor).toBe('1x9tbhn');
		expect(restored.context.processorFingerprint).toBe('fp-1x9tbhn');
	});

	it('does not throw on ANY simple_hash-shaped value', () => {
		// The failure was reachable for about 1.25% of digests, so one example is
		// luck rather than a test. This sweeps the shape.
		for (let i = 0; i < 5000; i++) {
			const digest = (i * 2654435761) % 0xffffffff;
			const value = digest.toString(36);
			expect(() => bnReviver('k', value)).not.toThrow();
			expect(bnReviver('k', value)).toBe(value);
		}
	});
});
