import {describe, expect, it} from 'vitest';
import {resolveIndexOptions} from '../src/options.js';
import type {Options} from '../src/types.js';

// ---------------------------------------------------------------------------------------------------
// `--store` NAMES WHERE THE STATE GOES, AND IT IS REQUIRED
// ---------------------------------------------------------------------------------------------------
// The two answers are not interchangeable -- one keeps a blob with no history,
// the other keeps versioned rows that answer as-of reads and survive a reorg --
// so a default would make the difference invisible at exactly the moment a
// deployment is choosing it.
//
// Everything below is resolved BEFORE anything is loaded or dialled, which is
// what lets `etherfold index` refuse a wrong combination without a network call.
// ---------------------------------------------------------------------------------------------------

const BASE: Options = {processor: './processor.js', nodeUrl: 'http://localhost:8545'};

describe('resolveIndexOptions — the store choice', () => {
	it('refuses a missing --store, naming both values', () => {
		expect(() => resolveIndexOptions(BASE)).toThrow(/--store.*file.*sqlite/s);
	});

	it('refuses a --store nobody implements', () => {
		expect(() => resolveIndexOptions({...BASE, store: 'postgres'})).toThrow(/postgres.*file.*sqlite/s);
	});
});

describe('resolveIndexOptions — --store file', () => {
	it('keeps the folder the free-form path has always written to', () => {
		expect(resolveIndexOptions({...BASE, store: 'file', folder: './state'}).target).toEqual({
			store: 'file',
			folder: './state',
		});
	});

	it('requires --folder, since that is where the state goes', () => {
		expect(() => resolveIndexOptions({...BASE, store: 'file'})).toThrow(/--folder/);
	});

	it('refuses --db, which names a database this store does not have', () => {
		expect(() => resolveIndexOptions({...BASE, store: 'file', folder: './state', db: 'file:./x.db'})).toThrow(
			/--db.*--store sqlite/s,
		);
	});

	it('refuses --retention, because a state blob keeps no history to retain', () => {
		expect(() => resolveIndexOptions({...BASE, store: 'file', folder: './state', retention: '500'})).toThrow(
			/--retention.*--store sqlite/s,
		);
	});
});

describe('resolveIndexOptions — --store sqlite', () => {
	it('takes the libSQL url and defaults retention to unbounded', () => {
		expect(resolveIndexOptions({...BASE, store: 'sqlite', db: 'file:./etherfold.db'}).target).toEqual({
			store: 'sqlite',
			db: 'file:./etherfold.db',
			retention: 'unbounded',
		});
	});

	it('requires --db rather than writing a database somewhere nobody named', () => {
		expect(() => resolveIndexOptions({...BASE, store: 'sqlite'})).toThrow(/--db/);
	});

	it('does NOT require --folder', () => {
		expect(() => resolveIndexOptions({...BASE, store: 'sqlite', db: ':memory:'})).not.toThrow();
	});

	it('refuses --folder rather than accepting one it would ignore', () => {
		expect(() => resolveIndexOptions({...BASE, store: 'sqlite', db: ':memory:', folder: './state'})).toThrow(
			/--folder.*--store file/s,
		);
	});
});

describe('resolveIndexOptions — retention is BLOCK NUMBERS (ADR-0019)', () => {
	const sqlite = {...BASE, store: 'sqlite', db: ':memory:'};

	it('reads a bare number as a window of blocks', () => {
		expect(resolveIndexOptions({...sqlite, retention: '500'}).target).toMatchObject({retention: {blocks: 500}});
	});

	it('takes the two named ends', () => {
		expect(resolveIndexOptions({...sqlite, retention: 'revert-only'}).target).toMatchObject({
			retention: 'revert-only',
		});
		expect(resolveIndexOptions({...sqlite, retention: 'unbounded'}).target).toMatchObject({retention: 'unbounded'});
	});

	it('refuses a duration, naming the one unit there is', () => {
		expect(() => resolveIndexOptions({...sqlite, retention: '2 days'})).toThrow(/block/i);
	});

	it('refuses a negative or fractional window', () => {
		expect(() => resolveIndexOptions({...sqlite, retention: '-1'})).toThrow(/block/i);
		expect(() => resolveIndexOptions({...sqlite, retention: '1.5'})).toThrow(/block/i);
	});
});
