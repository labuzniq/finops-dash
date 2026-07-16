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
    // The migrator's own "schema/relation already exists, skipping" notices fire
    // on every boot and drown the startup log. Real errors still throw.
    onnotice: () => {},
  });
  try {
    await migrate(drizzle(client), { migrationsFolder });
  } finally {
    await client.end();
  }
}
