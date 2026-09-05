import {createServer} from '@etherfold/server';
import {createD1DB} from './d1.js';
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
 *
 * It also hosts no processor, so it passes no `getIndexer` (the registry of
 * NAMED INDEXERS a host is built with) and the ingestion routes answer `501`; it owns no store either, so it passes no
 * `getCursorReport` and `/status` carries no `cursor` field rather than an
 * invented one. A deployment that DOES host one bundles its processor and
 * builds its store with `createD1Store` (`d1.ts`), which is where this host
 * states D1's per-request limits: the store is given the bounds THIS plan
 * allows, instead of a shared package carrying one vendor's numbers.
 */
export const app = createServer<CloudflareEnv>({
	getDB: (c) => createD1DB(c.env),
	getEnv: (c) => c.env,
});

export default {
	fetch: app.fetch,
};
