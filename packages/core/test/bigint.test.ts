import {describe, expect, it} from 'vitest';
import {taggedBnReplacer, taggedBnReviver} from '../src/utils/bigint.js';
import {simple_hash} from '../src/utils/hash.js';

// ---------------------------------------------------------------------------
// The tagged codec: what it claims, and what it must not touch
// ---------------------------------------------------------------------------
// The assertion that matters throughout this file is on the TYPE and not on the
// value. The convention this replaced encoded `123n` and the string `"123n"`
// identically, so every one of these round trips "passed" on value while
// silently swapping one for the other. A tag cannot: `{__bigint__: "123"}` is a
// shape a decoded log value has no way to be.
// ---------------------------------------------------------------------------

const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value, taggedBnReplacer), taggedBnReviver);

describe('the tagged BigInt codec', () => {
	it('round-trips a BigInt as a BigInt', () => {
		for (const value of [0n, 1n, -1n, 123n, -5n, 2n ** 256n]) {
			const restored = roundTrip({v: value});
			expect(restored.v).toBe(value);
			expect(typeof restored.v).toBe('bigint');
		}
	});

	it('round-trips a string that READS like a BigInt as a string', () => {
		// This is the whole point, and the assertion the `"123n"` convention could
		// not pass: these are legal values for a contract to emit.
		for (const value of ['123n', '0n', '-5n', '1x9tbhn', 'n', '0x1n']) {
			const restored = roundTrip({v: value});
			expect(restored.v).toBe(value);
			expect(typeof restored.v).toBe('string');
		}
	});

	it('keeps both kinds apart in ONE document', () => {
		const stored = {
			context: {processor: 'h1x9tbhn', config: '123n', processorFingerprint: 'fp-1x9tbhn'},
			unconfirmedBlocks: [{events: [{args: {id: 7n, memo: '7n'}}]}],
		};
		const restored = roundTrip(stored);

		expect(restored.unconfirmedBlocks[0].events[0].args.id).toBe(7n);
		expect(typeof restored.unconfirmedBlocks[0].events[0].args.id).toBe('bigint');
		// the same digits, one key away, and still a string
		expect(restored.unconfirmedBlocks[0].events[0].args.memo).toBe('7n');
		expect(typeof restored.unconfirmedBlocks[0].events[0].args.memo).toBe('string');
		expect(restored.context.config).toBe('123n');
		expect(typeof restored.context.config).toBe('string');
		expect(restored.context.processor).toBe('h1x9tbhn');
	});

	it('leaves every simple_hash digest a string, whatever shape it lands on', () => {
		// The old reviver called `BigInt()` on the middle of anything that started
		// with a digit and ended in `n`, which throws on an ordinary base36 digest
		// and, inside `JSON.parse`, reads as a corrupt snapshot. One example would
		// be luck rather than a test, so this sweeps the shape.
		for (let i = 0; i < 20000; i++) {
			const digest = simple_hash({payload: i});
			const restored = roundTrip({v: digest});
			expect(restored.v).toBe(digest);
			expect(typeof restored.v).toBe('string');
		}
	});

	it('never throws on a bare base36 digest either, including the shape that used to break', () => {
		let sawTheDangerousShape = false;
		for (let i = 0; i < 20000; i++) {
			const digest = ((i * 2654435761) % 0xffffffff).toString(36);
			if (/^\d/.test(digest) && digest.endsWith('n')) sawTheDangerousShape = true;
			expect(() => taggedBnReviver('k', digest)).not.toThrow();
			expect(taggedBnReviver('k', digest)).toBe(digest);
		}
		expect(sawTheDangerousShape).toBe(true);
	});

	it('tags a BigInt inside an array, and at the top level', () => {
		const inArray = roundTrip({v: [1n, '1n', 2n]});
		expect(inArray.v).toEqual([1n, '1n', 2n]);
		expect(typeof inArray.v[0]).toBe('bigint');
		expect(typeof inArray.v[1]).toBe('string');

		const bare = JSON.parse(JSON.stringify(9n, taggedBnReplacer), taggedBnReviver);
		expect(bare).toBe(9n);
	});

	it('writes the tag and nothing else', () => {
		expect(JSON.stringify({v: 123n}, taggedBnReplacer)).toBe('{"v":{"__bigint__":"123"}}');
		expect(JSON.stringify({v: '123n'}, taggedBnReplacer)).toBe('{"v":"123n"}');
	});
});

describe('the reviver, faced with objects that are not the tag', () => {
	it('leaves an object that merely CONTAINS the key alone', () => {
		const value = roundTrip({v: {__bigint__: '1', andSomethingElse: true}});
		expect(value.v).toEqual({__bigint__: '1', andSomethingElse: true});
	});

	it('leaves the tag key alone when it does not hold a string', () => {
		expect(taggedBnReviver('k', {__bigint__: 1})).toEqual({__bigint__: 1});
		expect(taggedBnReviver('k', {__bigint__: null})).toEqual({__bigint__: null});
	});

	it('leaves ordinary values alone', () => {
		for (const value of [1, true, null, 'token', [], {}]) {
			expect(taggedBnReviver('k', value)).toBe(value);
		}
	});
});

describe('the legacy `"123n"` suffix form', () => {
	// The DECISION this task recorded: the reader does not accept it at all. It is
	// not translated and it is not refused value-by-value -- it is simply a
	// string, because that is the only thing it unambiguously is. Where a
	// persisted artifact carries a FORMAT number (the CLI's snapshot envelope, a
	// captured stream fixture) the number was bumped, so a legacy file is refused
	// as a whole rather than half-read here.
	it('is read back as the string it now is, in every form', () => {
		for (const legacy of ['123n', '0n', '-5n']) {
			const restored = roundTrip({v: legacy});
			expect(restored.v).toBe(legacy);
			expect(typeof restored.v).toBe('string');
		}
	});

	it('is never WRITTEN, so no new file can carry the ambiguity', () => {
		expect(JSON.stringify({v: 123n}, taggedBnReplacer)).not.toContain('123n');
	});
});
