// Setup files run outside isolated storage and may run several times.
// `applyD1Migrations` only applies what is missing, so calling it here is safe.
import {applyD1Migrations, env} from 'cloudflare:test';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
