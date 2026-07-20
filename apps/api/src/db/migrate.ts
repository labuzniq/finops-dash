import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { env } from '../env.js';

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

/**
 * Applies any pending migrations on a dedicated single connection, as drizzle
 * requires. Called by `pnpm db:migrate` and by the API on boot.
 */
export async function runMigrations(): Promise<void> {
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
  } finally {
    await client.end();
  }
}
