import {describe, it, expect, beforeEach} from 'vitest';
import {createClient} from '@libsql/client';
import {RemoteLibSQL} from 'remote-sql-libsql';
import type {RemoteSQL} from 'remote-sql';
import {createServer, SCHEMA_VERSION} from '../src/index.js';
import {clearLastError} from '../src/api/status.js';

type TestEnv = {DEV?: string};

function serverOn(db: RemoteSQL) {
	return createServer<TestEnv>({getDB: () => db, getEnv: () => ({DEV: 'true'})});
}

function freshDB(): RemoteSQL {
	return new RemoteLibSQL(createClient({url: ':memory:'}));
}

describe('the server runs with no platform adapter', () => {
	beforeEach(() => clearLastError());

	it('reports unhealthy on a database whose schema was never applied', async () => {
		const res = await serverOn(freshDB()).request('/status');
		expect(res.status).toBe(503);
		const body = await res.json();
		expect(body.healthy).toBe(false);
		expect(body.database.reachable).toBe(true);
		expect(body.schema.applied).toBe(false);
	});

	it('reports healthy once the schema is applied', async () => {
		const app = serverOn(freshDB());
		const setup = await app.request('/admin/setup', {method: 'POST'});
		expect(setup.status).toBe(200);
		expect(await setup.json()).toEqual({success: true, version: SCHEMA_VERSION});

		const res = await app.request('/status');
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toMatchObject({
			healthy: true,
			database: {reachable: true},
			schema: {applied: true, version: SCHEMA_VERSION, expected: SCHEMA_VERSION, matches: true},
		});
	});

	it('applying the schema twice is idempotent, so a restart is not a migration', async () => {
		const app = serverOn(freshDB());
		await app.request('/admin/setup', {method: 'POST'});
		const second = await app.request('/admin/setup', {method: 'POST'});
		expect(second.status).toBe(200);
		expect((await (await app.request('/status')).json()).healthy).toBe(true);
	});

	it('distinguishes an unreachable database from a merely unmigrated one', async () => {
		const broken: RemoteSQL = {
			prepare: () => {
				throw new Error('connection refused');
			},
		} as unknown as RemoteSQL;

		const res = await serverOn(broken).request('/status');
		expect(res.status).toBe(503);
		const body = await res.json();
		expect(body.database.reachable).toBe(false);
		expect(body.database.error).toContain('connection refused');
		// and the failure is retained, which is what tells a wedged server from an idle one
		expect(body.lastError.message).toContain('connection refused');
	});

	it('reports a schema written by a different version as unhealthy rather than pretending', async () => {
		const db = freshDB();
		const app = serverOn(db);
		await app.request('/admin/setup', {method: 'POST'});
		await db.prepare(`UPDATE Meta SET value = ?1 WHERE key = ?2`).bind('999', 'schemaVersion').all();

		const res = await app.request('/status');
		expect(res.status).toBe(503);
		const body = await res.json();
		expect(body.healthy).toBe(false);
		expect(body.schema).toMatchObject({applied: true, version: 999, expected: SCHEMA_VERSION, matches: false});
	});

	it('injects per request, so two requests can hit two different databases', async () => {
		// this is the property that lets one app serve a D1 binding that only
		// exists per-request on Workers
		const a = freshDB();
		const b = freshDB();
		let current = a;
		const app = createServer<TestEnv>({getDB: () => current, getEnv: () => ({})});

		await app.request('/admin/setup', {method: 'POST'});
		expect((await (await app.request('/status')).json()).healthy).toBe(true);

		current = b;
		expect((await (await app.request('/status')).json()).schema.applied).toBe(false);
	});
});

describe('the SQL and the code agree about the schema version', () => {
	it('SCHEMA_VERSION matches the row db.sql actually inserts', async () => {
		// The version row is written by the SQL, because wrangler's D1 migrations
		// run the SQL and never call applySchema. This test is what keeps the
		// TypeScript constant honest about what the SQL does.
		const {default: sql} = await import('../src/schema/ts/db.sql.js');
		const match = /INSERT INTO Meta \(key, value\) VALUES \('schemaVersion', '(\d+)'\)/.exec(sql);
		expect(match, 'db.sql must insert a schemaVersion row').toBeTruthy();
		expect(Number(match![1])).toBe(SCHEMA_VERSION);
	});
});
