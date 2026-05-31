import {describe, expect, it} from 'vitest';
import {getNewToBlockFromError} from '../src/internal/engine/LogFetcher';

// Helper to build a JSON-RPC-style error object.
function rpcError(code: number, message?: string, data?: any) {
	return {code, message, data};
}

describe('getNewToBlockFromError', () => {
	describe('-32005 (limit exceeded)', () => {
		it('extracts the suggested toBlock from a "query returned more than 10000 results" message', () => {
			// 0xEC23F5 === 15475701
			const err = rpcError(
				-32005,
				'query returned more than 10000 results. Try with this block range [0xEC23E8, 0xEC23F5].'
			);
			expect(getNewToBlockFromError(err)).toBe(0xec23f5);
		});

		it('extracts the toBlock even when the message is not the canonical 10000-results phrasing', () => {
			const err = rpcError(-32005, 'too many results, retry with range [0x10, 0x20]');
			expect(getNewToBlockFromError(err)).toBe(0x20);
		});

		it('returns undefined when a -32005 error has no parseable range', () => {
			const err = rpcError(-32005, 'limit exceeded');
			expect(getNewToBlockFromError(err)).toBeUndefined();
		});

		it('does not throw when a -32005 error has no message at all', () => {
			const err = rpcError(-32005);
			expect(() => getNewToBlockFromError(err)).not.toThrow();
			expect(getNewToBlockFromError(err)).toBeUndefined();
		});
	});

	describe('-32602 (invalid params)', () => {
		// Regression test for the bug where ANY -32602 error with a message was parsed for a
		// block range, even unrelated "invalid params" errors. We now require the message to
		// look like a range/results hint.
		it('extracts the toBlock when the message mentions a block range', () => {
			const err = rpcError(-32602, 'invalid block range, try [0x100, 0x1ff]');
			expect(getNewToBlockFromError(err)).toBe(0x1ff);
		});

		it('extracts the toBlock when the message mentions results', () => {
			const err = rpcError(-32602, 'too many results [0xa, 0x14]');
			expect(getNewToBlockFromError(err)).toBe(0x14);
		});

		it('IGNORES an unrelated invalid-params error that happens to contain bracketed text', () => {
			// Before the fix this would have been mis-parsed into toBlock === 0x2.
			const err = rpcError(-32602, 'invalid argument 0: expected one of [0x1, 0x2]');
			expect(getNewToBlockFromError(err)).toBeUndefined();
		});

		it('returns undefined for a generic invalid-params error with no range info', () => {
			const err = rpcError(-32602, 'invalid params');
			expect(getNewToBlockFromError(err)).toBeUndefined();
		});

		it('does not throw when a -32602 error has no message', () => {
			const err = rpcError(-32602);
			expect(() => getNewToBlockFromError(err)).not.toThrow();
			expect(getNewToBlockFromError(err)).toBeUndefined();
		});
	});

	describe('unrelated errors', () => {
		it('returns undefined for unrelated error codes even when a range is present', () => {
			const err = rpcError(-32000, 'execution reverted [0x1, 0x2]');
			expect(getNewToBlockFromError(err)).toBeUndefined();
		});

		it('returns undefined for a -32603 "block range too large" error (handled elsewhere)', () => {
			const err = rpcError(-32603, 'block range too large');
			expect(getNewToBlockFromError(err)).toBeUndefined();
		});

		it('does not throw on an empty error object', () => {
			expect(() => getNewToBlockFromError({} as any)).not.toThrow();
			expect(getNewToBlockFromError({} as any)).toBeUndefined();
		});
	});
});
