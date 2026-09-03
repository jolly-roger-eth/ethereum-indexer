import {describe, expect, it} from 'vitest';
import {resolveIndexOptions} from '../src/options.js';
import type {Options} from '../src/types.js';

// ---------------------------------------------------------------------------------------------------
// `--store` NAMES WHERE THE STATE GOES, AND IT IS REQUIRED
// ---------------------------------------------------------------------------------------------------
// It named two stores -- a free-form blob with no history, and versioned rows
// that answer as-of reads and survive a reorg -- until the blob went with the
// processor path that wrote it (ADR-0037). One value is left, and the flag is
// kept as the axis a second backend arrives on.
//
// Everything below is resolved BEFORE anything is loaded or dialled, which is
// what lets `etherfold build` refuse a wrong combination without a network call.
// ---------------------------------------------------------------------------------------------------

const BASE: Options = {processor: './processor.js', nodeUrl: 'http://localhost:8545'};

describe('resolveIndexOptions — the store choice', () => {
	it('refuses a missing --store, naming the value there is', () => {
		expect(() => resolveIndexOptions(BASE)).toThrow(/--store.*sqlite/s);
	});

	it('refuses a --store nobody implements', () => {
		expect(() => resolveIndexOptions({...BASE, store: 'postgres'})).toThrow(/postgres.*sqlite/s);
	});

	it('refuses the retired free-form store rather than silently keeping a blob', () => {
		expect(() => resolveIndexOptions({...BASE, store: 'file', folder: './state'} as Options)).toThrow(/file.*sqlite/s);
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
