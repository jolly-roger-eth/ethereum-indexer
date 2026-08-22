import {describe, it, expect, afterEach} from 'vitest';
import {startServer, type RunningServer} from '../src/index.js';

let running: RunningServer | undefined;

afterEach(async () => {
	await running?.close();
	running = undefined;
});

describe('the node adapter serves the app over real HTTP', () => {
	it('starts, applies the schema, and reports healthy', async () => {
		running = await startServer({db: ':memory:', port: 0});

		const res = await fetch(`${running.url}/status`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {healthy: boolean; schema: {applied: boolean}};
		expect(body.healthy).toBe(true);
		expect(body.schema.applied).toBe(true);
	});

	it('honours autoSetup: false, so an operator can own migration', async () => {
		running = await startServer({db: ':memory:', port: 0, autoSetup: false});

		const before = await fetch(`${running.url}/status`);
		expect(before.status).toBe(503);
		expect(((await before.json()) as {schema: {applied: boolean}}).schema.applied).toBe(false);

		const setup = await fetch(`${running.url}/admin/setup`, {method: 'POST'});
		expect(setup.status).toBe(200);

		const after = await fetch(`${running.url}/status`);
		expect(after.status).toBe(200);
	});

	it('binds a real port when asked for 0, and reports which one', async () => {
		running = await startServer({db: ':memory:', port: 0});
		expect(running.port).toBeGreaterThan(0);
		expect(running.url).toContain(String(running.port));
	});
});
