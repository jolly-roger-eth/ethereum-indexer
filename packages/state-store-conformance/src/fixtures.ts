import {
	createMutationContext,
	type BlockPointer,
	type EntityDeclaration,
	type Mutation,
	type StateStore,
	type StateStoreCapabilities,
} from '@etherfold/state-store';
import type {ConformanceCase, StateStoreFactory} from './types.js';

/**
 * The declarations every case is written against.
 *
 * Deliberately small and hand-written. The heavy subject -- the captured
 * stratagems stream and the port that reproduced its state byte-identically --
 * is a separate task (`promote-stratagems-conformance-workload`) and a second
 * subject for this same suite, not a replacement for these: a case that fails on
 * 31,332 real events is a bug report nobody can read.
 *
 * Three entities, each earning its place: `token` is the ordinary
 * overwrite-and-delete subject, `player` carries the ACCUMULATED counter the
 * reorg case exists for (the field is named after the real one that went from 12
 * back to 6 in `work/notes/findings/sqlite-in-the-browser.md`), and `cell` has a
 * composite business key, which is the part of the id contract a single-column
 * fixture would never exercise.
 */
export const TOKEN: EntityDeclaration = {
	name: 'token',
	id: ['id'],
	fields: {owner: 'text', transferCount: 'integer'},
};

export const PLAYER: EntityDeclaration = {
	name: 'player',
	id: ['address'],
	fields: {computedPoints: 'integer'},
};

export const CELL: EntityDeclaration = {
	name: 'cell',
	id: ['x', 'y'],
	fields: {owner: 'text'},
};

/** What every factory is handed. A backend may not pick and choose among them. */
export const CONFORMANCE_ENTITIES: readonly EntityDeclaration[] = [TOKEN, PLAYER, CELL];

/**
 * The block the ladder cases start from, and the span they cover.
 *
 * A store that claims a window shorter than the span cannot be asked these
 * questions at all: its own claim says the oldest rung is already gone. The
 * suite asks it what it claims (see `answersHistoryOverLadder`) rather than
 * failing it for a window it never promised.
 */
export const LADDER_BASE = 100;
export const LADDER_SPAN = 8;

export function block(
	number: number,
	hash = `0x${number.toString(16)}`,
	timestamp = 1_700_000_000 + number * 12,
): BlockPointer {
	return {number, hash, timestamp};
}

export function owns(id: string, owner: string, transferCount: number): Mutation {
	return {type: 'upsert', entity: 'token', id: {id}, values: {owner, transferCount}};
}

export function burn(id: string): Mutation {
	return {type: 'delete', entity: 'token', id: {id}};
}

/** A store from the factory, migrated, exactly as a caller would get one. */
export async function opened(factory: StateStoreFactory): Promise<StateStore> {
	const store = await factory(CONFORMANCE_ENTITIES);
	await store.migrate();
	return store;
}

/**
 * The read-then-add-then-write accumulator, applied as one block.
 *
 * Written through `createMutationContext` rather than as a literal mutation
 * because that is the shape of the bug: the counter's next value is a function
 * of the value the store currently reports, so a store whose revert leaves the
 * old value standing keeps the points a reorged-out block gave it.
 */
export async function award(store: StateStore, at: BlockPointer, address: string, points: number): Promise<void> {
	const {state, mutations} = createMutationContext(store);
	const player = await state.get<{computedPoints: number | null}>('player', {address});
	state.set('player', {address}, {computedPoints: (player?.computedPoints ?? 0) + points});
	await store.applyBlock(at, mutations());
}

/** What `player` currently reports, as a plain number a case can compare. */
export async function pointsOf(store: StateStore, address: string): Promise<number | undefined> {
	const player = await store.getCurrent<{computedPoints: number}>('player', {address});
	return player?.computedPoints;
}

/** Turns `{name: run}` into cases, so a case reads like the `it` it becomes. */
export function cases(group: string, entries: Record<string, () => Promise<void>>): ConformanceCase[] {
	return Object.entries(entries).map(([name, run]) => ({group, name, run}));
}

/**
 * How many blocks behind its tip the store CLAIMS it can answer about.
 *
 * `0` for a store that answers no historical read at all. This is the only
 * question the suite asks of the report before choosing what to test, and it is
 * asked rather than assumed: testing a backend against a capability it never
 * claimed would fail honest backends, and testing it against less than it
 * claimed is what lets a claim be fiction.
 */
export function claimedDepth(capabilities: StateStoreCapabilities): number {
	if (!capabilities.asOf) return 0;
	switch (capabilities.retention.kind) {
		case 'revert-only':
			return 0;
		case 'window':
			return capabilities.retention.blocks;
		case 'unbounded':
			return Number.POSITIVE_INFINITY;
	}
}

/** Whether the store claims enough history for the ladder cases to be fair. */
export function answersHistoryOverLadder(capabilities: StateStoreCapabilities): boolean {
	return claimedDepth(capabilities) >= LADDER_SPAN;
}
