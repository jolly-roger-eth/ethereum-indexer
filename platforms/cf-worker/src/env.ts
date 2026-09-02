import type {D1Database} from '@cloudflare/workers-types';
import type {Env} from '@etherfold/server';

export type CloudflareEnv = Env & {
	DB: D1Database;
	/**
	 * Which D1/Workers plan this deployment runs on: `free` (the default) or
	 * `paid`. It decides the per-request bounds the state store is given, and the
	 * two plans' caps differ by 20x, so it is a deployment VARIABLE rather than a
	 * constant in code. See `d1.ts` and `wrangler.toml`.
	 */
	D1_PLAN?: string;
	NAMED_LOGS?: string;
	NAMED_LOGS_LEVEL?: string;
};
