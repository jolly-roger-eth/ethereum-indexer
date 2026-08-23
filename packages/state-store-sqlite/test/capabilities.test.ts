import {describe, expect, it} from 'vitest';
import {VersionedStateStore} from '../src/index.js';
import {createTestDB} from './utils/db.js';
import {TOKEN, block, owns} from './utils/fixtures.js';

/**
 * A backend states what it can do BEFORE anyone asks it a question, which is the
 * difference between discovering a missing capability at startup and
 * discovering it from a wrong number in production.
 */
describe('declared capabilities', () => {
	it('are readable before migrate and before any read', () => {
		const store = new VersionedStateStore(createTestDB(), [TOKEN]);
		expect(store.capabilities).toEqual({retention: {kind: 'unbounded'}, asOf: true});
	});

	it('claim `unbounded` because that is what is TRUE: this package does not prune', async () => {
		const store = new VersionedStateStore(createTestDB(), [TOKEN]);
		await store.migrate();
		await store.applyBlock(block(10), [owns('1', '0xalice', 1)]);
		await store.applyBlock(block(1_000_000), [owns('1', '0xbob', 2)]);

		// a million blocks later, the first version is still readable. A store that
		// reported a window here would be claiming an enforcement it does not have.
		expect(store.capabilities.retention).toEqual({kind: 'unbounded'});
		expect(await store.getAsOf<{owner: string}>('token', {id: '1'}, 10)).toMatchObject({owner: '0xalice'});
	});

	it('claim `asOf`, and answer as-of reads', async () => {
		const store = new VersionedStateStore(createTestDB(), [TOKEN]);
		await store.migrate();
		await store.applyBlock(block(10), [owns('1', '0xalice', 1)]);

		expect(store.capabilities.asOf).toBe(true);
		expect(await store.getAsOf('token', {id: '1'}, 9)).toBeUndefined();
		expect(await store.getAsOf<{owner: string}>('token', {id: '1'}, 10)).toMatchObject({owner: '0xalice'});
	});
});
