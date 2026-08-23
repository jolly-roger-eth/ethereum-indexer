import {MemoryStateStore, type EntityDeclaration, type StateStoreCapabilities} from '@etherfold/state-store';

/**
 * The reference store, DECLARING a window of N block numbers.
 *
 * A test double rather than a shipped backend, for one reason: nothing prunes
 * yet (`prune-versions-outside-retention-window` is that work), so a shipped
 * store claiming a window would be claiming an enforcement it does not have,
 * which is what the capability report exists to prevent. What it does have is
 * the half that is real today, the read side refusing at the window's edge
 * instead of answering from the tip.
 *
 * Overriding the report is the whole of it: `MemoryStateStore.getAsOf` guards
 * against `this.capabilities`, so a subclass that claims a window enforces it
 * without writing a second copy of the refusal. That is also why a LYING backend
 * cannot be built this way, and is built as a decorator instead (see
 * `the-suite-catches.test.ts`).
 */
export class WindowedMemoryStore extends MemoryStateStore {
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
