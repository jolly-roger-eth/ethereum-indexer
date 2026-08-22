import {processorCodeFingerprint} from '../../src/utils/fingerprint.js';

/**
 * A processor's source as TEXT, so that two processes can be handed the exact
 * same bytes.
 *
 * `Function.prototype.toString()` returns the source as the ENGINE received it,
 * which in this repo is always transpiler output (esbuild under vitest, tsc for
 * `dist`). A fixture written as a normal object literal would therefore be
 * fingerprinted from whatever the transpiler printed, and the cross-process test
 * would be asserting that two transpiler runs agree rather than that the
 * fingerprint is stable. Keeping the source in a string and `eval`-ing it takes
 * the transpiler out of the comparison: a string literal crosses a transpiler
 * unchanged.
 */
export const FIXTURE_SOURCE = `{
	version: '1.0.0',
	construct() {
		return {owners: {}, transferCount: 0};
	},
	onTransfer(state, event) {
		state.owners[event.args.id.toString()] = event.args.to;
		state.transferCount++;
	},
}`;

/** The fingerprint of `FIXTURE_SOURCE`, computed in whatever process calls this. */
export function fixtureFingerprint(): string | undefined {
	const processor = (0, eval)(`(${FIXTURE_SOURCE})`) as object;
	return processorCodeFingerprint(processor);
}
