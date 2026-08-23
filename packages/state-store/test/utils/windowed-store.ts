import {MemoryStateStore, type EntityDeclaration, type StateStoreCapabilities} from '../../src/index.js';

/**
 * A store that DECLARES a window of N block numbers.
 *
 * It is a test double and not a shipped backend, for one reason: nothing in this
 * repo prunes yet (`prune-versions-outside-retention-window` is that work), so a
 * shipped store claiming a window would be claiming an enforcement it does not
 * have, which is exactly what the capability report exists to prevent. What it
 * DOES have is the half this task lands: the read side refuses at the window's
 * edge instead of answering from the tip.
 *
 * Overriding the report is the whole of it. `getAsOf` guards against
 * `this.capabilities`, so the refusal is the seam's and not a second copy
 * written here, which is what makes this double worth testing through.
 */
export class WindowedStore extends MemoryStateStore {
	constructor(
		declarations: Iterable<EntityDeclaration>,
		private readonly windowInBlocks: number,
	) {
		super(declarations);
	}

	override get capabilities(): StateStoreCapabilities {
		return {retention: {kind: 'window', blocks: this.windowInBlocks}, asOf: true};
	}
}
