import type {Retention, StateStoreCapabilities} from './capabilities.js';
import {BlockNotRetainedError} from './errors.js';

/**
 * ## Retention, from the deployment's side
 *
 * `Retention` (in `capabilities.ts`) is what a store REPORTS. This module is the
 * other half: what a deployment SETS, how it is validated, and what a read that
 * falls outside it gets back.
 *
 * The two are deliberately not the same type. A setting is a request, and a
 * store reports what it can actually provide: a store with no pruning that is
 * asked for a window keeps MORE than it was asked to (see
 * `retentionWithoutPruning`), and it says `unbounded` rather than claiming an
 * enforcement it does not have.
 */

/**
 * What a deployment writes: a distance in BLOCK NUMBERS, or one of the two ends.
 *
 * The window is `{blocks: N}` and not a bare `N`, because a bare number names no
 * unit and this surface has exactly one. It is also not `{seconds}`, `{days}` or
 * `{updates}`, and those are rejected loudly rather than ignored (see
 * `resolveRetention`).
 *
 * **Choosing N is not choosing a number of updates.** On the real measured
 * stream (the launched stratagems game on Base) event-bearing blocks are median
 * **429 blocks apart**, so a window of 64 blocks holds exactly ONE event-bearing
 * block, and reading "64 blocks" as "64 updates of history" is wrong by orders
 * of magnitude on any sparse contract. Size a window against the chain's block
 * rate and the contract's activity, not against how much history it feels like.
 */
export type RetentionSetting =
	| 'revert-only'
	| 'unbounded'
	/** Keep superseded versions for `blocks` block numbers behind the tip. */
	| {readonly blocks: number};

/** What `resolveRetention` needs to know besides the setting itself. */
export type RetentionOptions = {
	/**
	 * The reorg depth this deployment protects against, in block numbers.
	 *
	 * Required whenever a window is set and unused otherwise: reorg revert
	 * reopens versions closed after the fork point, so a window shorter than the
	 * finality depth would prune the versions revert itself needs.
	 */
	readonly finalityDepth?: number;
};

/** The block numbers a store can still answer about: `from` and `to` inclusive. */
export type RetainedRange = {readonly from: number; readonly to: number};

/** The retention of a store nothing was asked of: keep everything, claim nothing. */
export const DEFAULT_RETENTION: Retention = {kind: 'unbounded'};

/**
 * Read a deployment's setting into the report shape, or throw.
 *
 * Every rejection here is a decision the spec records rather than a preference:
 *
 * - **A window below the finality depth** is refused naming both numbers. Reorg
 *   revert already requires retaining superseded versions that far back, so a
 *   shorter window is not a smaller store, it is a broken one.
 * - **A duration** is refused on every spelling. Time prunes on WALL-CLOCK
 *   progress rather than chain progress: a stalled indexer would drop history it
 *   never finished writing, and a halted chain would expire its whole window
 *   while the tip stands still. (Time is already solved on the READ side, where
 *   a timestamp resolves to the latest block at or before it.)
 * - **A count of updates** is refused because it is derivable, not a second
 *   mode: every backend already indexes the blocks that changed something, so
 *   "the last N updates" resolves to a floor BLOCK NUMBER above the seam and the
 *   one enforcement path does the rest.
 *
 * The default, when nothing is set, is `unbounded`: no shipped store prunes, so
 * it is the only report that is TRUE of them, and any default window would be
 * both a claim nothing enforces and (at the sizes that look generous) nearly
 * empty in updates on a real stream.
 */
export function resolveRetention(setting: RetentionSetting | undefined, options: RetentionOptions): Retention {
	if (setting === undefined) return DEFAULT_RETENTION;
	if (setting === 'revert-only') return {kind: 'revert-only'};
	if (setting === 'unbounded') return {kind: 'unbounded'};

	if (typeof setting !== 'object' || setting === null || !('blocks' in setting)) {
		throw new Error(
			`invalid retention: ${JSON.stringify(setting)}. Retention is measured in BLOCK NUMBERS and in no other ` +
				`unit: write {blocks: N}, 'revert-only' or 'unbounded'. A duration is refused because it would prune on ` +
				`wall-clock progress rather than chain progress, and a count of updates is refused because it is a floor ` +
				`block number derived above this seam, not a second retention kind.`,
		);
	}

	const blocks = (setting as {blocks: unknown}).blocks;
	if (typeof blocks !== 'number' || !Number.isInteger(blocks) || blocks < 0) {
		throw new Error(
			`invalid retention window: ${JSON.stringify(blocks)}. A window is a distance in block numbers, so it must ` +
				`be a non-negative integer.`,
		);
	}

	const {finalityDepth} = options;
	if (finalityDepth === undefined) {
		throw new Error(
			`a retention window of ${blocks} blocks states no finality depth to protect. Reorg revert reopens versions ` +
				`closed after the fork point, so a window is only meaningful next to the depth it must not go under: pass ` +
				`the finality depth alongside it.`,
		);
	}
	if (!Number.isInteger(finalityDepth) || finalityDepth < 0) {
		throw new Error(`invalid finality depth: ${JSON.stringify(finalityDepth)}. Expected a non-negative integer.`);
	}
	if (blocks < finalityDepth) {
		throw new Error(
			`retention window of ${blocks} blocks is below the finality depth of ${finalityDepth}. Reorg revert reopens ` +
				`versions closed after the fork point, so the finality depth is retention's FLOOR and not a suggestion: a ` +
				`window of ${blocks} would prune the versions a revert needs. Set the window to ${finalityDepth} or more.`,
		);
	}

	return {kind: 'window', blocks};
}

/**
 * What a store that does not prune may honestly report, given what it was asked
 * for.
 *
 * A window becomes `unbounded`, because that is what such a store actually does:
 * it keeps everything. This understates its retention, which is the safe
 * direction (a caller relying on the report asks for LESS history than is
 * there); claiming the window would be the dangerous one, since the report would
 * promise a bound nothing enforces and a long-running store would grow anyway.
 *
 * `revert-only` passes through, because refusing every historical read is
 * enforceable with no pruning at all, and `unbounded` is already the truth.
 *
 * This exists here rather than in each store so that the rule and its reasoning
 * are singular. It disappears from a store the day that store prunes
 * (`prune-versions-outside-retention-window`).
 */
export function retentionWithoutPruning(requested: Retention): Retention {
	return requested.kind === 'window' ? {kind: 'unbounded'} : requested;
}

/**
 * The block numbers a store can answer about, given its retention and its tip.
 *
 * `undefined` means none of them: a `revert-only` store keeps superseded
 * versions for revert and answers no historical read, and that is an absence of
 * a range rather than an empty one.
 */
export function retainedRange(retention: Retention, tip: number): RetainedRange | undefined {
	switch (retention.kind) {
		case 'revert-only':
			return undefined;
		case 'window':
			return {from: Math.max(0, tip - retention.blocks), to: tip};
		case 'unbounded':
			return {from: 0, to: tip};
	}
}

/**
 * Refuse a historical read the store's declared capabilities do not cover.
 *
 * This is the enforcement half of the capability report, written once so that
 * every backend refuses identically and a caller can catch one error type
 * whatever it is reading from.
 *
 * The tip is a THUNK because most stores never need it: an `unbounded` store
 * refuses nothing and a `revert-only` store refuses everything, so only a
 * windowed store pays for the lookup. A store with no blocks applied yet has no
 * tip to measure a distance from, and is not refused: it has no history to be
 * outside of, and the read answers `undefined` honestly.
 *
 * A read ABOVE the tip is not refused either. "As of a block we have not reached"
 * is the tip state, which is what the version ranges already answer, and it is
 * `NoSuchBlockError`'s business (not retention's) when an address identifies no
 * block at all.
 */
export async function assertRetained(
	capabilities: StateStoreCapabilities,
	requested: number,
	tip: () => number | undefined | Promise<number | undefined>,
): Promise<void> {
	const retention = capabilities.retention;
	if (!capabilities.asOf || retention.kind === 'revert-only') {
		throw new BlockNotRetainedError(requested, undefined, 'no-historical-reads', retention);
	}
	if (retention.kind !== 'window') return;

	const at = await tip();
	if (at === undefined) return;

	const retained = retainedRange(retention, at);
	if (retained && requested < retained.from) {
		throw new BlockNotRetainedError(requested, retained, 'outside-window', retention);
	}
}
