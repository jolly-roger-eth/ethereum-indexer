import {RemoteD1} from 'remote-sql-d1';
import {createServer} from '@etherfold/server';
import type {CloudflareEnv} from './env.js';

/**
 * The Worker host.
 *
 * Everything platform-shaped is here and nowhere else: the D1 binding arrives on
 * the per-request `env`, which is exactly why `@etherfold/server` resolves its
 * database per request rather than once at construction.
 *
 * Note what this host deliberately does NOT do: apply the schema on boot. The
 * Node adapter does that, because there is one process owning one file. Here
 * there are many instances against one D1, so migration is an operator action
 * (`POST /admin/setup`, or wrangler), not something several isolates race to do.
 */
export const app = createServer<CloudflareEnv>({
	getDB: (c) => new RemoteD1(c.env.DB as never),
	getEnv: (c) => c.env,
});

export default {
	fetch: app.fetch,
};
