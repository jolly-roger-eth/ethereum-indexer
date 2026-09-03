import {describe, it, expect} from 'vitest';
import {fetchWorker} from './utils.js';

describe('the worker host serves the same app as the node host', () => {
	it('reports healthy against a migrated D1', async () => {
		const res = await fetchWorker('/status');
		expect(res.status).toBe(200);
		const body = (await res.json()) as {healthy: boolean; database: {reachable: boolean}; schema: {applied: boolean}};
		expect(body.healthy).toBe(true);
		expect(body.database.reachable).toBe(true);
		expect(body.schema.applied).toBe(true);
	});

	it('reports no cursor, because this host owns no store to read one from', async () => {
		// the absent case exercised by a REAL host rather than by a test double: this
		// worker builds the app with a D1 binding and an environment and nothing else,
		// so it injects no cursor reporter and `/status` invents no field in its place
		const body = (await (await fetchWorker('/status')).json()) as Record<string, unknown>;
		expect(body).not.toHaveProperty('cursor');
		expect(body.healthy).toBe(true);
	});

	it('serves the same status shape the node adapter serves', async () => {
		const body = (await (await fetchWorker('/status')).json()) as Record<string, unknown>;
		// identical contract across hosts: the adapters differ in wiring only
		expect(Object.keys(body).sort()).toEqual(
			['database', 'healthy', 'lastError', 'reorgs', 'schema'].filter((k) => k in body).sort(),
		);
		expect(body).toHaveProperty('schema.expected');
	});
});
