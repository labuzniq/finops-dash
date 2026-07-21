import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { env } from '../env.js';
import { eventDuration, moduleLogger } from '../log.js';

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

const log = moduleLogger('db.migrate');

/**
 * Applies any pending migrations on a dedicated single connection, as drizzle
 * requires. Called by `pnpm db:migrate` and by the API on boot.
 */
export async function runMigrations(): Promise<void> {
  const startedAt = Date.now();
  log.debug({ dash: { dbSchema: env.DB_SCHEMA } }, 'applying pending migrations');

  const client = postgres(env.DATABASE_URL, {
    max: 1,
    // Unqualified names in the migration SQL resolve here, so the whole
    // dataset lands in DB_SCHEMA. The migrator's own bookkeeping table is
    // unaffected — it stays in the explicitly-qualified "drizzle" schema.
    connection: { search_path: env.DB_SCHEMA },
    // The migrator's own "schema/relation already exists, skipping" notices fire
    // on every boot and drown the startup log. Real errors still throw.
    onnotice: () => {},
  });
  try {
    // DB_SCHEMA is validated as a plain identifier in env.ts, so interpolation
    // is safe here.
    await client.unsafe(`CREATE SCHEMA IF NOT EXISTS "${env.DB_SCHEMA}"`);
    await migrate(drizzle(client), { migrationsFolder });
    log.info(
      { 'event.action': 'db-migrate', 'event.outcome': 'success', 'event.duration': eventDuration(startedAt) },
      'migrations applied',
    );
  } catch (error) {
    log.error(
      { 'event.action': 'db-migrate', 'event.outcome': 'failure', err: error },
      'migration failed',
    );
    throw error;
  } finally {
    await client.end();
  }
}
