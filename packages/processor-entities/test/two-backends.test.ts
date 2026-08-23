import {createClient} from '@libsql/client';
import {MemoryStateStore, type StateStore} from '@etherfold/state-store';
import {VersionedStateStore} from '@etherfold/state-store-sqlite';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {beforeEach, describe, expect, it} from 'vitest';
import {applyEventStream, type EntityProcessor} from '../src/index.js';
import {processor, transfer, type TestABI} from './utils/fixtures.js';

/**
 * The claim this whole seam exists to make: ONE processor, several backends,
 * identical state.
 *
 * Both backends here are real. The SQLite one is a real local libSQL database
 * behind `remote-sql`, never a mock, because the properties that matter (a
 * re-applied block raising, the DELETE-before-reopen ordering inside `revertTo`)
 * are properties of an engine. The other keeps versioned rows in a Map and owes
 * nothing to SQL, which is what makes the equality below worth asserting: if the
 * seam had leaked SQL semantics, this is where it would show.
 *
 * The processor object is imported, not written twice. Nothing in it names a
 * backend.
 */

type Backend = {name: string; make(): StateStore};

const backends: Backend[] = [
	{name: 'memory', make: () => new MemoryStateStore(processor.entities)},
	{
		name: 'sqlite',
		make: () => new VersionedStateStore(new RemoteLibSQL(createClient({url: ':memory:'})), processor.entities),
	},
];

/** The declared fields only: the version columns are storage, not state. */
async function stateOf(store: StateStore, ids: string[]): Promise<Record<string, unknown>> {
	const state: Record<string, unknown> = {};
	for (const id of ids) {
		const token = await store.getCurrent<Record<string, unknown>>('token', {id});
		state[`token/${id}`] = token && {owner: token.owner, transferCount: token.transferCount};
	}
	const counter = await store.getCurrent<Record<string, unknown>>('counter', {name: 'transfers'});
	state['counter/transfers'] = counter && {value: counter.value};
	return state;
}

const IDS = ['1', '2', '3'];

/** A stream with a burst in one block, a later block, and nothing exotic. */
const STREAM = [
	transfer(100, '0xA', {from: '0x0', to: '0xalice', id: 1n}),
	transfer(100, '0xA', {from: '0x0', to: '0xzoe', id: 2n}),
	transfer(100, '0xA', {from: '0xalice', to: '0xbob', id: 1n}),
	transfer(101, '0xB', {from: '0xzoe', to: '0xcarol', id: 2n}),
	transfer(102, '0xC', {from: '0x0', to: '0xdan', id: 3n}),
];

describe('one processor, several backends', () => {
	let states: Record<string, Record<string, unknown>>;

	beforeEach(async () => {
		states = {};
		for (const backend of backends) {
			const store = backend.make();
			await store.migrate();
			await applyEventStream(store, processor, STREAM, undefined);
			states[backend.name] = await stateOf(store, IDS);
		}
	});

	it('produces the same state on every backend', () => {
		expect(states['sqlite']).toEqual(states['memory']);
	});

	it('produces the state the handlers describe, so "the same" is not "the same wrong"', () => {
		expect(states['memory']).toEqual({
			// token 1 moved twice, both moves inside block 100
			'token/1': {owner: '0xbob', transferCount: 2},
			'token/2': {owner: '0xcarol', transferCount: 2},
			'token/3': {owner: '0xdan', transferCount: 1},
			// five transfers, three of them in one block: read-your-writes composed
			'counter/transfers': {value: 5},
		});
	});
});

describe.each(backends)('the seam behaves the same on $name', (backend) => {
	let store: StateStore;

	beforeEach(async () => {
		store = backend.make();
		await store.migrate();
	});

	it('composes two events in one block through read-your-writes', async () => {
		await applyEventStream(store, processor, STREAM.slice(0, 3), undefined);
		expect(await stateOf(store, ['1'])).toEqual({
			'token/1': {owner: '0xbob', transferCount: 2},
			'counter/transfers': {value: 3},
		});
	});

	it('answers as of an earlier block', async () => {
		await applyEventStream(store, processor, STREAM, undefined);
		expect(await store.getAsOf<{value: number}>('counter', {name: 'transfers'}, 100)).toMatchObject({value: 3});
		expect(await store.getAsOf<{owner: string}>('token', {id: '3'}, 101)).toBeUndefined();
	});

	it('makes a counter DECREASE when the block that raised it is reverted', async () => {
		await applyEventStream(store, processor, STREAM, undefined);
		// the canonical reorg bug: block 102 is retracted with no replacement
		await applyEventStream(
			store,
			processor,
			[transfer(102, '0xC', {from: '0x0', to: '0xdan', id: 3n}, {removed: true})],
			undefined,
		);

		expect(await stateOf(store, IDS)).toEqual({
			'token/1': {owner: '0xbob', transferCount: 2},
			'token/2': {owner: '0xcarol', transferCount: 2},
			'token/3': undefined,
			'counter/transfers': {value: 4},
		});
	});

	it('replaces a reorged height with the canonical branch, on both', async () => {
		await applyEventStream(store, processor, [transfer(100, '0xAAA', {from: '0x0', to: '0xalice', id: 1n})], undefined);
		await applyEventStream(
			store,
			processor,
			[
				transfer(100, '0xAAA', {from: '0x0', to: '0xalice', id: 1n}, {removed: true}),
				transfer(100, '0xBBB', {from: '0x0', to: '0xcarol', id: 1n}),
			],
			undefined,
		);
		expect(await stateOf(store, ['1'])).toEqual({
			'token/1': {owner: '0xcarol', transferCount: 1},
			'counter/transfers': {value: 1},
		});
	});

	it('raises when the same block is applied twice, rather than double-writing versions', async () => {
		await applyEventStream(store, processor, STREAM.slice(0, 3), undefined);
		await expect(applyEventStream(store, processor, STREAM.slice(0, 3), undefined)).rejects.toThrow();
	});

	it('carries an untouched field through `update` and clears it through `set`', async () => {
		// Worth running against the REAL engine and not only the reference store: a
		// SQL `SELECT *` hands back `_lower` / `_upper` alongside the declared
		// fields, and `update` spreads what `get` returned. If the version columns
		// rode along into the write, this is where it would show.
		const partial: EntityProcessor<TestABI> = {
			...processor,
			async onTransfer(state, event) {
				const id = event.args.id.toString();
				if (event.args.from === '0x0') {
					state.set('token', {id}, {owner: event.args.to, transferCount: 1});
				} else {
					// only the owner changes; transferCount is not mentioned
					await state.update('token', {id}, {owner: event.args.to});
				}
			},
		};

		await applyEventStream(store, partial, [transfer(100, '0xA', {from: '0x0', to: '0xalice', id: 1n})], undefined);
		await applyEventStream(store, partial, [transfer(101, '0xB', {from: '0xalice', to: '0xbob', id: 1n})], undefined);

		expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xbob', transferCount: 1});

		// and the primitive still writes a WHOLE row: `set` without transferCount nulls it
		// (annotated, not inlined: the handler map MAPS over the ABI's event names, so
		// `TestABI` is not inferrable from an object LITERAL and the handler arguments
		// would be implicitly `any`.)
		const wholeRow: EntityProcessor<TestABI> = {
			...processor,
			async onTransfer(state, event) {
				state.set('token', {id: event.args.id.toString()}, {owner: event.args.to});
			},
		};

		await applyEventStream(store, processor, [transfer(102, '0xC', {from: '0x0', to: '0xcarol', id: 2n})], undefined);
		await applyEventStream(store, wholeRow, [transfer(103, '0xD', {from: '0xcarol', to: '0xdan', id: 2n})], undefined);
		expect(await store.getCurrent('token', {id: '2'})).toMatchObject({owner: '0xdan', transferCount: null});
	});

	it('reports its capabilities before anything is read', () => {
		// Both keep everything today, and say so. Neither claims a window it does
		// not enforce: no store here prunes yet.
		expect(store.capabilities).toEqual({retention: {kind: 'unbounded'}, asOf: true});
	});
});
