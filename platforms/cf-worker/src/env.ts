import type {D1Database} from '@cloudflare/workers-types';
import type {Env} from '@etherfold/server';

export type CloudflareEnv = Env & {
	DB: D1Database;
	NAMED_LOGS?: string;
	NAMED_LOGS_LEVEL?: string;
};
