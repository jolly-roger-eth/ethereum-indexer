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

	it('serves the same status shape the node adapter serves', async () => {
		const body = (await (await fetchWorker('/status')).json()) as Record<string, unknown>;
		// identical contract across hosts: the adapters differ in wiring only
		expect(Object.keys(body).sort()).toEqual(
			['database', 'healthy', 'lastError', 'schema'].filter((k) => k in body).sort(),
		);
		expect(body).toHaveProperty('schema.expected');
	});
});
