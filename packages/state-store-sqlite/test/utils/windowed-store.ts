import type {EntityDeclaration, StateStoreCapabilities} from '@etherfold/state-store';
import type {RemoteSQL} from 'remote-sql';
import {VersionedStateStore} from '../../src/index.js';

/**
 * What a windowed SQLite store will do once it can honestly claim a window.
 *
 * The claim is overridden rather than configured, because a shipped store that
 * claimed a window today would be claiming an enforcement it does not have (no
 * pruning: `prune-versions-outside-retention-window`). What is real here is
 * everything below the claim: the tip comes out of the block table, and the
 * refusal is the seam's, so this double answers and refuses exactly as the
 * shipped store will the day it prunes.
 */
export class WindowedStore extends VersionedStateStore {
	constructor(
		db: RemoteSQL,
		declarations: Iterable<EntityDeclaration>,
		private readonly windowInBlocks = 60,
	) {
		super(db, declarations);
	}

	override get capabilities(): StateStoreCapabilities {
		return {retention: {kind: 'window', blocks: this.windowInBlocks}, asOf: true};
	}
}
