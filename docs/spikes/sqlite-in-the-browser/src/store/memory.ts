/**
 * The reference backend: entity rows in a Map, versions in a list.
 *
 * It exists for two jobs. It is the store the port runs against when the trace
 * is recorded (so the trace is a property of the PROCESSOR, not of any storage
 * candidate), and it is the control in the browser measurements: the floor that
 * says how much of a number is storage and how much is just JavaScript.
 */
import {
	RetentionUnavailableError,
	rowKey,
	type BlockStore,
	type BlockUpdate,
	type EntityId,
	type Mutation,
	type Retention,
} from './types.js';

type Version = {
	lower: number;
	upper: number | undefined;
	values: Record<string, unknown> | undefined;
};

export class MemoryBlockStore implements BlockStore {
	readonly name = 'memory';
	private versions = new Map<string, Version[]>();
	private appliedBlocks: number[] = [];

	constructor(readonly retention: Retention = {kind: 'unbounded'}) {}

	async open(): Promise<void> {}
	async close(): Promise<void> {}

	async applyBlock(update: BlockUpdate): Promise<void> {
		for (const mutation of update.mutations) {
			this.applyMutation(update.block.number, mutation);
		}
		this.appliedBlocks.push(update.block.number);
		this.prune(update.block.number);
	}

	private applyMutation(blockNumber: number, mutation: Mutation): void {
		const key = rowKey(mutation.entity, mutation.id);
		const list = this.versions.get(key) ?? [];
		const live = list.length > 0 ? list[list.length - 1] : undefined;
		if (live && live.upper === undefined) {
			live.upper = blockNumber;
		}
		if (mutation.type === 'upsert') {
			list.push({lower: blockNumber, upper: undefined, values: {...mutation.values}});
		} else if (live === undefined || live.values === undefined) {
			// deleting something that was never there is a no-op, exactly as
			// `delete state.map[key]` is on a missing key
			return;
		}
		this.versions.set(key, list);
	}

	private prune(tip: number): void {
		if (this.retention.kind === 'unbounded') return;
		const floor = this.retention.kind === 'window' ? tip - this.retention.blocks : tip;
		for (const [key, list] of this.versions) {
			const kept = list.filter((version) => version.upper === undefined || version.upper > floor);
			if (kept.length !== list.length) this.versions.set(key, kept);
		}
	}

	async get(entity: string, id: EntityId): Promise<Record<string, unknown> | undefined> {
		const list = this.versions.get(rowKey(entity, id));
		if (!list || list.length === 0) return undefined;
		const live = list[list.length - 1];
		return live.upper === undefined ? live.values : undefined;
	}

	async getAsOf(entity: string, id: EntityId, blockNumber: number): Promise<Record<string, unknown> | undefined> {
		const tip = this.appliedBlocks.length > 0 ? this.appliedBlocks[this.appliedBlocks.length - 1] : 0;
		if (this.retention.kind === 'revert-only' && blockNumber < tip) {
			throw new RetentionUnavailableError(this.name, blockNumber, this.retention);
		}
		if (this.retention.kind === 'window' && blockNumber < tip - this.retention.blocks) {
			throw new RetentionUnavailableError(this.name, blockNumber, this.retention);
		}
		const list = this.versions.get(rowKey(entity, id));
		if (!list) return undefined;
		for (const version of list) {
			if (version.lower <= blockNumber && (version.upper === undefined || version.upper > blockNumber)) {
				return version.values;
			}
		}
		return undefined;
	}

	async revertTo(blockNumber: number): Promise<void> {
		for (const [key, list] of this.versions) {
			const kept = list.filter((version) => version.lower <= blockNumber);
			for (const version of kept) {
				if (version.upper !== undefined && version.upper > blockNumber) version.upper = undefined;
			}
			this.versions.set(key, kept);
		}
		this.appliedBlocks = this.appliedBlocks.filter((number) => number <= blockNumber);
	}

	/** Every live row, for the projection that checks the port against the oracle. */
	liveRows(): {entity: string; id: string; values: Record<string, unknown>}[] {
		const rows: {entity: string; id: string; values: Record<string, unknown>}[] = [];
		for (const [key, list] of this.versions) {
			const live = list.length > 0 ? list[list.length - 1] : undefined;
			if (!live || live.upper !== undefined || live.values === undefined) continue;
			const [entity, id] = key.split('\u0000');
			rows.push({entity, id, values: live.values});
		}
		return rows;
	}

	versionCount(): number {
		let count = 0;
		for (const list of this.versions.values()) count += list.length;
		return count;
	}
}
